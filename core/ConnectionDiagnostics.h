#pragma once

#include <array>
#include <cstdint>
#include <deque>
#include <sstream>
#include <string>
#include "BitStream.h"
#include "NetworkTypes.h"
#include "PacketEnumerations.h"

// Inbound metadata only. No packet bodies, account names, passwords or machine
// identifiers are retained. The caller holds the native client's existing lock.
class ConnectionDiagnostics {
    struct Rpc { uint64_t count=0; uint32_t bits=0; bool supported=false; };
    struct Check { uint8_t type=0; uint32_t address=0; uint16_t offset=0, count=0; bool valid=false; };
    std::array<Rpc,256> rpcs{};
    std::deque<Check> checks;
    uint64_t packets=0, rpcCount=0, malformed=0, checkCount=0;
public:
    bool attempted=false, transportAccepted=false, joinSent=false;
    bool gameInitialized=false, spawnSent=false, launcherNotice=false;
    enum class End { None, Local, Server, Lost, Banned, Failed, Full, Password, Timeout, Rejected, Authentication };
    End end=End::None;

    void reset() { *this=ConnectionDiagnostics{}; attempted=true; }
    void handler(int id) { if(id>=0&&id<256)rpcs[id].supported=true; }
    void observe(const Packet* packet) {
        if(!packet||!packet->data||packet->length==0)return;
        ++packets;
        if(packet->bitSize>uint64_t(packet->length)*8) { ++malformed; return; }
        unsigned int offset=0;
        if(packet->data[0]==ID_TIMESTAMP)offset=1+sizeof(RakNetTime);
        if(offset>=packet->length) { ++malformed; return; }
        if(packet->data[offset]!=ID_RPC)return;
        RakNet::BitStream input(packet->data,packet->length,false);
        input.IgnoreBits((offset+1)*8);
        uint8_t id=0;
        unsigned int bits=0;
        if(!input.Read(id)||!input.ReadCompressed(bits)||bits>input.GetNumberOfUnreadBits()
           ||(packet->bitSize&&uint64_t(input.GetReadOffset())+bits>packet->bitSize)) {
            ++malformed; return;
        }
        ++rpcCount;
        ++rpcs[id].count; rpcs[id].bits=bits;
        if(id==103) {
            ++checkCount;
            Check value;
            value.valid=bits==72&&input.Read(value.type)&&input.Read(value.address)
                &&input.Read(value.offset)&&input.Read(value.count);
            if(checks.size()==16)checks.pop_front();
            checks.push_back(value);
        }
    }
    static const char* endName(End value) {
        switch(value) {
        case End::Local:return "local-disconnect";
        case End::Server:return "server-disconnected";
        case End::Lost:return "connection-lost";
        case End::Banned:return "connection-banned";
        case End::Failed:return "connection-attempt-failed";
        case End::Full:return "server-full";
        case End::Password:return "server-password-rejected";
        case End::Timeout:return "connection-timeout";
        case End::Rejected:return "connection-rejected";
        case End::Authentication:return "unsupported-auth-key";
        default:return "none";
        }
    }
    std::string json(int currentState) const {
        std::ostringstream out;
        out << std::boolalpha << "{\"schema\":1,\"protocol\":\"SA-MP 0.3.7\",\"netgame\":4057"
            << ",\"attempted\":" << attempted << ",\"currentState\":" << currentState
            << ",\"transportAccepted\":" << transportAccepted << ",\"clientJoinSent\":" << joinSent
            << ",\"gameInitialized\":" << gameInitialized << ",\"spawnSent\":" << spawnSent
            << ",\"accountAccessConfirmed\":null,\"launcherNoticeReceived\":" << launcherNotice
            << ",\"disconnectReason\":\"" << endName(end) << "\",\"inboundPackets\":" << packets
            << ",\"inboundRpcs\":" << rpcCount << ",\"malformedPackets\":" << malformed
            << ",\"clientCheckCount\":" << checkCount << ",\"clientChecks\":[";
        bool comma=false;
        for(const auto& check:checks) {
            if(comma)out << ','; comma=true;
            out << "{\"type\":" << unsigned(check.type) << ",\"address\":" << check.address
                << ",\"offset\":" << check.offset << ",\"byteCount\":" << check.count
                << ",\"validRequest\":" << check.valid << ",\"responseImplemented\":false}";
        }
        out << "],\"unhandledRpcs\":["; comma=false;
        for(size_t id=0;id<rpcs.size();++id)if(rpcs[id].count&&!rpcs[id].supported) {
            if(comma)out << ','; comma=true;
            out << "{\"id\":" << id << ",\"count\":" << rpcs[id].count << ",\"lastBits\":" << rpcs[id].bits << '}';
        }
        out << "],\"privacy\":\"inbound-metadata-only; no credentials or packet bodies\"}";
        return out.str();
    }
};
