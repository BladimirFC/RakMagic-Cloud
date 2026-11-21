// SPDX-License-Identifier: MIT
// RakMagic's private loopback UDP adapter. Only the in-memory WireGuard
// netstack can reach remote game destinations; there is no direct fallback.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

const headerSize = 26
const maxDatagram = 2048

var outputMu sync.Mutex

func emit(v any)              { outputMu.Lock(); defer outputMu.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(v) }
func issue(code string) error { return errors.New(code) }

type configuration struct {
	addresses, dns []netip.Addr
	allowed        []netip.Prefix
	ipc            string
	mtu            int
}

func parseConfig(file string) (configuration, error) {
	c := configuration{mtu: 1280}
	f, e := os.Open(file)
	if e != nil {
		return c, issue("WG_CONFIG_MISSING")
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Size() > 65536 {
		return c, issue("WG_CONFIG_INVALID")
	}
	scanner := bufio.NewScanner(io.LimitReader(f, 65537))
	section := ""
	seen := map[string]bool{}
	values := map[string]string{}
	for scanner.Scan() {
		s := strings.TrimSpace(scanner.Text())
		if s == "" || strings.HasPrefix(s, "#") || strings.HasPrefix(s, ";") {
			continue
		}
		if s == "[Interface]" || s == "[Peer]" {
			if seen[s] {
				return c, issue("WG_ONE_PEER_REQUIRED")
			}
			seen[s] = true
			section = s
			continue
		}
		k, v, ok := strings.Cut(s, "=")
		if !ok || section == "" {
			return c, issue("WG_CONFIG_INVALID")
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		id := section + k
		if _, ok = values[id]; ok {
			return c, issue("WG_DUPLICATE_OPTION")
		}
		values[id] = v
		valid := section == "[Interface]" && (k == "PrivateKey" || k == "Address" || k == "DNS" || k == "MTU") || section == "[Peer]" && (k == "PublicKey" || k == "PresharedKey" || k == "Endpoint" || k == "AllowedIPs" || k == "PersistentKeepalive")
		if !valid {
			return c, issue("WG_UNSUPPORTED_OPTION")
		}
	}
	if scanner.Err() != nil || !seen["[Interface]"] || !seen["[Peer]"] {
		return c, issue("WG_CONFIG_INVALID")
	}
	var ipc strings.Builder
	for _, k := range []struct {
		section, key, ipc string
		required          bool
	}{{"[Interface]", "PrivateKey", "private_key", true}, {"[Peer]", "PublicKey", "public_key", true}, {"[Peer]", "PresharedKey", "preshared_key", false}} {
		v := values[k.section+k.key]
		if v == "" && !k.required {
			continue
		}
		raw, e := base64.StdEncoding.Strict().DecodeString(v)
		if e != nil || len(raw) != 32 || bytes.Equal(raw, make([]byte, 32)) {
			return c, issue("WG_KEY_INVALID")
		}
		fmt.Fprintf(&ipc, "%s=%s\n", k.ipc, hex.EncodeToString(raw))
		clear(raw)
	}
	endpoint, e := netip.ParseAddrPort(values["[Peer]Endpoint"])
	if e != nil || endpoint.Port() == 0 || !endpoint.Addr().IsGlobalUnicast() {
		return c, issue("WG_ENDPOINT_INVALID")
	}
	fmt.Fprintf(&ipc, "endpoint=%s\nreplace_allowed_ips=true\n", endpoint)
	for _, v := range strings.Split(values["[Peer]AllowedIPs"], ",") {
		p, e := netip.ParsePrefix(strings.TrimSpace(v))
		if e != nil {
			return c, issue("WG_ALLOWED_IPS_INVALID")
		}
		p = p.Masked()
		c.allowed = append(c.allowed, p)
		fmt.Fprintf(&ipc, "allowed_ip=%s\n", p)
	}
	for _, v := range strings.Split(values["[Interface]Address"], ",") {
		p, e := netip.ParsePrefix(strings.TrimSpace(v))
		if e != nil {
			return c, issue("WG_ADDRESS_INVALID")
		}
		c.addresses = append(c.addresses, p.Addr())
	}
	if s := values["[Interface]DNS"]; s != "" {
		for _, v := range strings.Split(s, ",") {
			a, e := netip.ParseAddr(strings.TrimSpace(v))
			if e != nil {
				return c, issue("WG_DNS_INVALID")
			}
			c.dns = append(c.dns, a)
		}
	}
	if s := values["[Interface]MTU"]; s != "" {
		c.mtu, e = strconv.Atoi(s)
		if e != nil || c.mtu < 1280 || c.mtu > 1420 {
			return c, issue("WG_MTU_INVALID")
		}
	}
	keepalive := 25
	if s := values["[Peer]PersistentKeepalive"]; s != "" {
		keepalive, e = strconv.Atoi(s)
		if e != nil || keepalive < 0 || keepalive > 65535 {
			return c, issue("WG_KEEPALIVE_INVALID")
		}
	}
	fmt.Fprintf(&ipc, "persistent_keepalive_interval=%d\n", keepalive)
	c.ipc = ipc.String()
	return c, nil
}

type request struct {
	ID    int    `json:"id"`
	Op    string `json:"op"`
	Token string `json:"token"`
	IP    string `json:"ip"`
	Port  int    `json:"port"`
}
type flow struct {
	socket  net.Conn
	client  *net.UDPAddr
	remote  netip.AddrPort
	touched time.Time
}
type relay struct {
	ctx     context.Context
	tnet    *netstack.Net
	socket  *net.UDPConn
	token   []byte
	mu      sync.Mutex
	targets map[netip.AddrPort]bool
	flows   map[string]*flow
	allowed []netip.Prefix
}

func (r *relay) permit(ip string, port int) bool {
	a, e := netip.ParseAddr(ip)
	if e != nil || !a.Is4() || !a.IsGlobalUnicast() || a.IsPrivate() || port < 1 || port > 65535 {
		return false
	}
	contains := false
	for _, p := range r.allowed {
		if p.Contains(a) {
			contains = true
			break
		}
	}
	if !contains {
		return false
	}
	target := netip.AddrPortFrom(a, uint16(port))
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.targets) >= 16 && !r.targets[target] {
		return false
	}
	r.targets[target] = true
	return true
}
func (r *relay) remove(key string, f *flow) {
	r.mu.Lock()
	if r.flows[key] == f {
		delete(r.flows, key)
	}
	r.mu.Unlock()
	_ = f.socket.Close()
}
func (r *relay) responses(key string, f *flow) {
	defer r.remove(key, f)
	payload := make([]byte, maxDatagram)
	for {
		_ = f.socket.SetReadDeadline(time.Now().Add(30 * time.Second))
		n, e := f.socket.Read(payload)
		if e != nil {
			if t, ok := e.(net.Error); ok && t.Timeout() {
				r.mu.Lock()
				idle := time.Since(f.touched)
				r.mu.Unlock()
				if idle < 2*time.Minute && r.ctx.Err() == nil {
					continue
				}
			}
			return
		}
		if n < 1 {
			continue
		}
		r.mu.Lock()
		f.touched = time.Now()
		r.mu.Unlock()
		packet := make([]byte, headerSize+n)
		copy(packet, "RWG1")
		copy(packet[4:20], r.token)
		a := f.remote.Addr().As4()
		copy(packet[20:24], a[:])
		binary.BigEndian.PutUint16(packet[24:26], f.remote.Port())
		copy(packet[26:], payload[:n])
		if _, e = r.socket.WriteToUDP(packet, f.client); e != nil {
			return
		}
	}
}
func (r *relay) serve() {
	packet := make([]byte, 65535)
	for {
		n, client, e := r.socket.ReadFromUDP(packet)
		if e != nil {
			return
		}
		if !client.IP.IsLoopback() || n <= headerSize || n > headerSize+maxDatagram || string(packet[:4]) != "RWG1" || subtle.ConstantTimeCompare(packet[4:20], r.token) != 1 {
			continue
		}
		a := netip.AddrFrom4([4]byte(packet[20:24]))
		target := netip.AddrPortFrom(a, binary.BigEndian.Uint16(packet[24:26]))
		key := client.String() + "/" + target.String()
		r.mu.Lock()
		permitted := r.targets[target]
		f := r.flows[key]
		count := len(r.flows)
		r.mu.Unlock()
		if !permitted {
			continue
		}
		if f == nil {
			if count >= 32 {
				continue
			}
			ctx, cancel := context.WithTimeout(r.ctx, 3*time.Second)
			s, e := r.tnet.DialContext(ctx, "udp4", target.String())
			cancel()
			if e != nil {
				continue
			}
			f = &flow{socket: s, client: client, remote: target, touched: time.Now()}
			r.mu.Lock()
			r.flows[key] = f
			r.mu.Unlock()
			go r.responses(key, f)
		}
		r.mu.Lock()
		f.touched = time.Now()
		r.mu.Unlock()
		_ = f.socket.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if _, e = f.socket.Write(packet[headerSize:n]); e != nil {
			r.remove(key, f)
		}
	}
}
func status(dev *device.Device, r *relay) {
	state := map[string]any{"type": "status", "transport": "wireguard", "handshake": false, "handshakeAgeSeconds": nil, "receivedBytes": int64(0), "sentBytes": int64(0)}
	data, e := dev.IpcGet()
	if e == nil {
		var stamp int64
		for _, line := range strings.Split(data, "\n") {
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			n, _ := strconv.ParseInt(v, 10, 64)
			switch k {
			case "last_handshake_time_sec":
				stamp = n
			case "rx_bytes":
				state["receivedBytes"] = n
			case "tx_bytes":
				state["sentBytes"] = n
			}
		}
		if stamp > 0 {
			age := time.Now().Unix() - stamp
			if age < 0 {
				age = 0
			}
			state["handshake"] = true
			state["handshakeAgeSeconds"] = age
		}
	}
	r.mu.Lock()
	state["flows"] = len(r.flows)
	r.mu.Unlock()
	emit(state)
}
func run(file string) error {
	c, e := parseConfig(file)
	if e != nil {
		return e
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 16384)
	if !scanner.Scan() {
		return issue("WG_START_REQUIRED")
	}
	var start request
	if json.Unmarshal(scanner.Bytes(), &start) != nil || start.Op != "start" {
		return issue("WG_START_INVALID")
	}
	token, e := hex.DecodeString(start.Token)
	if e != nil || len(token) != 16 {
		return issue("WG_TOKEN_INVALID")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	tun, tnet, e := netstack.CreateNetTUN(c.addresses, c.dns, c.mtu)
	if e != nil {
		return issue("WG_NETSTACK_FAILED")
	}
	dev := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	defer dev.Close()
	if dev.IpcSet(c.ipc) != nil {
		return issue("WG_CONFIGURATION_REJECTED")
	}
	c.ipc = ""
	if dev.Up() != nil {
		return issue("WG_NETWORK_UNAVAILABLE")
	}
	local, e := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if e != nil {
		return issue("WG_LOOPBACK_UNAVAILABLE")
	}
	defer local.Close()
	r := &relay{ctx: ctx, tnet: tnet, socket: local, token: token, targets: make(map[netip.AddrPort]bool), flows: make(map[string]*flow), allowed: c.allowed}
	defer func() {
		r.mu.Lock()
		for _, f := range r.flows {
			_ = f.socket.Close()
		}
		r.mu.Unlock()
	}()
	go r.serve()
	emit(map[string]any{"type": "ready", "version": "0.6.5", "port": local.LocalAddr().(*net.UDPAddr).Port, "transport": "wireguard", "handshakeConfirmed": false})
	verifySlot := make(chan struct{}, 1)
	go func() {
		defer cancel()
		for scanner.Scan() {
			var q request
			if json.Unmarshal(scanner.Bytes(), &q) != nil {
				continue
			}
			if q.Op == "stop" {
				return
			}
			if q.Op == "verify" {
				select {
				case verifySlot <- struct{}{}:
					go func(id int) { defer func() { <-verifySlot }(); r.verifyEgress(id) }(q.ID)
				default:
					emit(map[string]any{"type": "egress", "id": q.ID, "ok": false, "reason": "EGRESS_BUSY"})
				}
			}
			if q.Op == "allow" {
				emit(map[string]any{"type": "reply", "id": q.ID, "ok": r.permit(q.IP, q.Port)})
			}
		}
	}()
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			status(dev, r)
		}
	}
}
func main() {
	file := flag.String("config", "wireguard.conf", "Private WireGuard configuration")
	flag.Parse()
	if e := run(*file); e != nil {
		emit(map[string]any{"type": "fatal", "code": e.Error()})
		os.Exit(1)
	}
}
