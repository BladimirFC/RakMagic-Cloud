#include "ConnectionDiagnostics.h"
#include <array>
#include <cstdlib>
#include <cstring>
#include <iostream>

static void check(bool condition) { if(!condition)std::abort(); }
static void observe(ConnectionDiagnostics& value,unsigned char* data,unsigned int bytes,unsigned int bits=0) {
    Packet packet{};packet.data=data;packet.length=bytes;packet.bitSize=bits;
    value.observe(&packet);
}
int main() {
    ConnectionDiagnostics value;value.reset();value.handler(42);
    std::array<unsigned char,20> large{};large[0]=220;
    std::memcpy(large.data()+1,"synthetic-secret",16);
    observe(value,large.data(),large.size(),large.size()*8);
    unsigned char shortPacket[]{220,1,2};observe(value,shortPacket,sizeof(shortPacket));
    std::array<unsigned char,1+sizeof(RakNetTime)+3> timestamped{};
    timestamped[0]=ID_TIMESTAMP;timestamped[1+sizeof(RakNetTime)]=220;
    observe(value,timestamped.data(),timestamped.size(),timestamped.size()*8);
    unsigned char ui[]{248,5};observe(value,ui,sizeof(ui),16);
    unsigned char truncated[]{ID_TIMESTAMP};observe(value,truncated,sizeof(truncated),8);
    observe(value,large.data(),large.size(),large.size()*8+1);
    observe(value,large.data(),large.size(),7);
    RakNet::BitStream rpc;
    rpc.Write(uint8_t(ID_RPC));rpc.Write(uint8_t(42));rpc.WriteCompressed(unsigned(8));rpc.Write(uint8_t(127));
    observe(value,rpc.GetData(),rpc.GetNumberOfBytesUsed(),rpc.GetNumberOfBitsUsed());
    const auto json=value.json(3);
    check(json.find("\"packetInventoryAvailable\":true")!=std::string::npos);
    check(json.find("\"inboundPackets\":8")!=std::string::npos);
    check(json.find("\"inboundRpcs\":1")!=std::string::npos);
    check(json.find("\"malformedPackets\":3")!=std::string::npos);
    check(json.find("\"id\":220,\"count\":3,\"minBytes\":3,\"maxBytes\":20,\"lastBits\":24,\"timestamped\":1")!=std::string::npos);
    check(json.find("\"id\":248,\"count\":1,\"minBytes\":2,\"maxBytes\":2,\"lastBits\":16,\"timestamped\":0")!=std::string::npos);
    check(json.find("\"unhandledRpcs\":[]")!=std::string::npos);
    check(json.find("synthetic-secret")==std::string::npos);
    std::cout << json << '\n';
    value.reset();const auto reset=value.json(0);
    check(reset.find("\"packetTypes\":[]")!=std::string::npos);
    check(reset.find("\"inboundPackets\":0")!=std::string::npos);
    return 0;
}
