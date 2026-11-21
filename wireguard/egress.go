// SPDX-License-Identifier: MIT
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"net/netip"
	"time"
)

// Fixed public observers. DNS resolution and UDP both use the WireGuard
// netstack; no operating-system dialer or direct-network fallback is used.
var observers = []string{"stun.l.google.com:19302", "stun.cloudflare.com:3478"}

func publicIPv4(a netip.Addr) bool {
	if !a.Is4() || !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() {
		return false
	}
	for _, s := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4"} {
		if netip.MustParsePrefix(s).Contains(a) {
			return false
		}
	}
	return true
}

// RFC 5389: validate the Binding Success header, transaction ID and all
// attribute lengths before accepting an IPv4 XOR-MAPPED-ADDRESS.
func mappedAddress(packet, transaction []byte) (string, error) {
	if len(packet) < 20 || len(transaction) != 12 || binary.BigEndian.Uint16(packet[:2]) != 0x0101 || binary.BigEndian.Uint32(packet[4:8]) != 0x2112a442 || !bytes.Equal(packet[8:20], transaction) {
		return "", issue("EGRESS_INVALID_RESPONSE")
	}
	length := int(binary.BigEndian.Uint16(packet[2:4]))
	if length%4 != 0 || length+20 != len(packet) {
		return "", issue("EGRESS_INVALID_RESPONSE")
	}
	var result string
	for offset := 20; offset < len(packet); {
		if offset+4 > len(packet) {
			return "", issue("EGRESS_INVALID_RESPONSE")
		}
		typ, size := binary.BigEndian.Uint16(packet[offset:]), int(binary.BigEndian.Uint16(packet[offset+2:]))
		start := offset + 4
		end := start + size
		padded := start + ((size + 3) &^ 3)
		if end > len(packet) || padded > len(packet) {
			return "", issue("EGRESS_INVALID_RESPONSE")
		}
		if typ == 0x0020 && size == 8 && packet[start] == 0 && packet[start+1] == 1 {
			v := binary.BigEndian.Uint32(packet[start+4:end]) ^ 0x2112a442
			a := netip.AddrFrom4([4]byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)})
			if !publicIPv4(a) || result != "" && result != a.String() {
				return "", issue("EGRESS_INVALID_ADDRESS")
			}
			result = a.String()
		}
		offset = padded
	}
	if result == "" {
		return "", issue("EGRESS_NO_ADDRESS")
	}
	return result, nil
}

func (r *relay) observe(ctx context.Context, endpoint string) (string, error) {
	c, err := r.tnet.DialContext(ctx, "udp4", endpoint)
	if err != nil {
		return "", issue("EGRESS_OBSERVER_UNREACHABLE")
	}
	defer c.Close()
	stop := context.AfterFunc(ctx, func() { _ = c.Close() })
	defer stop()
	packet := make([]byte, 20)
	binary.BigEndian.PutUint16(packet[:2], 1)
	binary.BigEndian.PutUint32(packet[4:8], 0x2112a442)
	if _, err = rand.Read(packet[8:20]); err != nil {
		return "", issue("EGRESS_RANDOM_FAILED")
	}
	for attempt := 0; attempt < 3; attempt++ {
		if ctx.Err() != nil {
			break
		}
		_ = c.SetDeadline(time.Now().Add(3 * time.Second))
		if _, err = c.Write(packet); err != nil {
			continue
		}
		buf := make([]byte, 2048)
		n, e := c.Read(buf)
		if e == nil {
			if ip, e := mappedAddress(buf[:n], packet[8:20]); e == nil {
				return ip, nil
			}
		}
	}
	return "", issue("EGRESS_OBSERVER_UNREACHABLE")
}

func (r *relay) verifyEgress(id int) {
	ctx, cancel := context.WithTimeout(r.ctx, 12*time.Second)
	defer cancel()
	type result struct {
		index int
		ip    string
		err   error
	}
	results := make(chan result, len(observers))
	for index, endpoint := range observers {
		go func(index int, endpoint string) {
			ip, err := r.observe(ctx, endpoint)
			results <- result{index, ip, err}
		}(index, endpoint)
	}
	ips := make([]string, len(observers))
	ok := true
	for range observers {
		value := <-results
		ips[value.index] = value.ip
		ok = ok && value.err == nil
	}
	reason := ""
	if !ok {
		reason = "EGRESS_OBSERVER_UNREACHABLE"
	} else if ips[0] != ips[1] {
		ok = false
		reason = "EGRESS_OBSERVERS_DISAGREE"
	}
	ip := ""
	if ok {
		ip = ips[0]
	}
	emit(map[string]any{"type": "egress", "id": id, "ok": ok, "ip": ip, "method": "stun-udp4-two-observers", "reason": reason})
}
