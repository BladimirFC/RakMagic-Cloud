#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <sstream>
#include <string>

// A manual diagnostic response to the F4 inventory request. There are no
// prebuilt F4 interfaces implemented here, so the advertised list is empty.
// This is independent of launcher authentication and never includes inputs.
class UiInventoryProbe {
    uint64_t requests_=0,replies_=0,failures_=0;
    bool attempted_=false;
public:
    void reset(){*this=UiInventoryProbe{};}
    void observe(const unsigned char* data,std::size_t bytes){
        if(data&&bytes==2&&data[0]==248&&data[1]==5)++requests_;
    }
    template<class Send> bool sendEmptyInventory(bool connected,Send send){
        if(!connected||!requests_||attempted_)return false;
        attempted_=true;
        // Data's constructor writes F8 followed by event family 100; its
        // inventory serializer appends 3, 0 and the unsigned entry count.
        const std::array<unsigned char,5> bytes{{248,100,3,0,0}};
        if(!send(bytes)){++failures_;return false;}
        ++replies_;return true;
    }
    std::string json()const{
        std::ostringstream out;
        out<<"{\"requests\":"<<requests_<<",\"attempted\":"<<(attempted_?"true":"false")
           <<",\"repliesSent\":"<<replies_<<",\"sendFailures\":"<<failures_<<",\"interfaceCount\":0}";
        return out.str();
    }
};
