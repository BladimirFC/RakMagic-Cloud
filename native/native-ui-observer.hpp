#pragma once
#include <cstdint>
#include "ui-inventory-probe.hpp"

namespace {
struct NativeUiObserverState {
    uint64_t observed=0,captured=0,dropped=0,windowBytes=0;
    unsigned windowFrames=0;
    std::chrono::steady_clock::time_point window=std::chrono::steady_clock::now();
} nativeUiObserver;
UiInventoryProbe nativeUiInventory;
bool nativeUiObserverEnabled(){
    static const bool enabled=[](){const char* v=std::getenv("RAKMAGIC_NATIVE_UI_DIAGNOSTIC");return v&&std::string(v)=="1";}();
    return enabled;
}
}
void cloudNativeUiReset(){nativeUiObserver=NativeUiObserverState{};nativeUiInventory.reset();}
void cloudNativeUiObserve(const unsigned char* data,std::size_t length){
    if(!nativeUiObserverEnabled()||!data||!length||data[0]!=248)return;
    nativeUiInventory.observe(data,length);
    auto& s=nativeUiObserver;++s.observed;
    const auto now=std::chrono::steady_clock::now();
    if(now-s.window>=std::chrono::seconds(1)){s.window=now;s.windowBytes=0;s.windowFrames=0;}
    if(length<2||length>65536||s.windowFrames>=64||length>524288-s.windowBytes){++s.dropped;return;}
    ++s.windowFrames;s.windowBytes+=length;++s.captured;
    // Private child->parent IPC only. worker-ui consumes this event before
    // any console, account handler or API can see it. Never write a raw dump.
    static const char hex[]="0123456789abcdef";
    std::string out="{\"type\":\"nativeUiPacket\",\"bytes\":"+std::to_string(length)+",\"hex\":\"";
    out.reserve(out.size()+length*2+3);
    for(std::size_t i=0;i<length;++i){out+=hex[data[i]>>4];out+=hex[data[i]&15];}
    out+="\"}";emit(std::move(out));
}
std::string cloudNativeUiTransport(){
    const auto& s=nativeUiObserver;
    return std::string("{\"enabled\":")+(nativeUiObserverEnabled()?"true":"false")+
        ",\"observed\":"+std::to_string(s.observed)+",\"captured\":"+std::to_string(s.captured)+
        ",\"dropped\":"+std::to_string(s.dropped)+"}";
}
