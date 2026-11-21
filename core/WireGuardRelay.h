// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <array>
#include <cstdlib>
#include <cstring>
#include <cerrno>

namespace RakMagicWireGuard {
constexpr unsigned headerSize=26;
struct Options { bool required=false,valid=false; unsigned short port=0;std::array<unsigned char,16> token{}; };
inline const Options& options(){
    static const Options result=[](){
        Options o;const char *required=std::getenv("RAKMAGIC_WG_REQUIRED");
        o.required=required&&std::strcmp(required,"1")==0;if(!o.required)return o;
        const char *port=std::getenv("RAKMAGIC_WG_RELAY_PORT"),*token=std::getenv("RAKMAGIC_WG_RELAY_TOKEN");
        if(!port||!token||std::strlen(token)!=32)return o;
        char *end=nullptr;const unsigned long value=std::strtoul(port,&end,10);if(!end||*end||value<1||value>65535)return o;
        auto digit=[](char c)->int{if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;};
        for(unsigned i=0;i<16;++i){const int a=digit(token[i*2]),b=digit(token[i*2+1]);if(a<0||b<0)return o;o.token[i]=static_cast<unsigned char>((a<<4)|b);}
        o.port=static_cast<unsigned short>(value);o.valid=true;return o;
    }();return result;
}
inline int sendPacket(SOCKET socket,const char *data,int length,const sockaddr_in& remote){
    const auto& o=options();if(!o.required)return sendto(socket,data,length,0,reinterpret_cast<const sockaddr*>(&remote),sizeof(remote));
    if(!o.valid||length<1||length>MAXIMUM_MTU_SIZE+1){errno=EINVAL;return SOCKET_ERROR;}
    std::array<unsigned char,MAXIMUM_MTU_SIZE+1+headerSize> packet{};
    std::memcpy(packet.data(),"RWG1",4);std::memcpy(packet.data()+4,o.token.data(),16);
    std::memcpy(packet.data()+20,&remote.sin_addr.s_addr,4);std::memcpy(packet.data()+24,&remote.sin_port,2);std::memcpy(packet.data()+headerSize,data,static_cast<unsigned>(length));
    sockaddr_in relay{};relay.sin_family=AF_INET;relay.sin_addr.s_addr=htonl(INADDR_LOOPBACK);relay.sin_port=htons(o.port);
    const int sent=sendto(socket,packet.data(),length+headerSize,0,reinterpret_cast<const sockaddr*>(&relay),sizeof(relay));
    return sent==length+static_cast<int>(headerSize)?length:SOCKET_ERROR;
}
inline bool unwrap(char *data,int& length,sockaddr_in& from){
    const auto& o=options();if(!o.required)return true;
    if(!o.valid||from.sin_addr.s_addr!=htonl(INADDR_LOOPBACK)||from.sin_port!=htons(o.port)||length<=static_cast<int>(headerSize)||length>MAXIMUM_MTU_SIZE+static_cast<int>(headerSize)||std::memcmp(data,"RWG1",4)!=0)return false;
    unsigned mismatch=0;for(unsigned i=0;i<16;++i)mismatch|=static_cast<unsigned char>(data[i+4])^o.token[i];if(mismatch)return false;
    std::memcpy(&from.sin_addr.s_addr,data+20,4);std::memcpy(&from.sin_port,data+24,2);
    length-=headerSize;std::memmove(data,data+headerSize,static_cast<unsigned>(length));return true;
}
}
