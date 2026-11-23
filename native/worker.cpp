#include <cstddef>
#include <string>
void cloudNativeUiObserve(const unsigned char*,std::size_t);
void cloudNativeUiReset();
std::string cloudNativeUiTransport();
#define RAKMAGIC_NATIVE_UI_OBSERVE(data,length) cloudNativeUiObserve(data,length)
#define RAKMAGIC_PASSIVE_UI_ONLY
#include <client_android.cpp>
#include "native-ui-observer.hpp"
#include <iostream>
#include <sstream>
#include <poll.h>
#include <unistd.h>
#include <signal.h>

namespace {
volatile sig_atomic_t stopping = 0;
void stopSignal(int) { stopping = 1; }
JNIEnv env;
bool decode(const std::string& input, std::vector<jbyte>& output) {
    if(input=="-")return true;
    if(input.size()>8192||input.size()%4)return false;
    const std::string alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    uint32_t value=0;int bits=0;bool padding=false;int pads=0;
    for(char c:input){
        if(c=='='){padding=true;if(++pads>2)return false;continue;}
        auto index=alphabet.find(c);if(padding||index==std::string::npos)return false;
        value=(value<<6)|uint32_t(index);bits+=6;
        if(bits>=8){bits-=8;output.push_back(jbyte((value>>bits)&255));}
    }
    return bits<8&&((value&((1u<<bits)-1))==0);
}
void response(unsigned id,bool ok){std::cout<<"{\"type\":\"workerReply\",\"request\":"<<id<<",\"ok\":"<<(ok?"true":"false")<<"}\n";}
void status();
bool execute(const std::string& line){
    std::istringstream in(line);unsigned id;std::string command;
    if(!(in>>id>>command)||id==0||id>2147483647)return false;
    if(command=="send"||command=="reply"||command=="click"||command=="spawn"||command=="pause"||command=="restorePause"||command=="restoreMenuPause"||command=="cancelSelection"){
        response(id,false);return true;
    }
    std::array<std::vector<jbyte>,4> values;
    auto data=[&](int index){std::string s;return bool(in>>s)&&decode(s,values[index]);};
    bool ok=false;
    if(command=="uiInventoryEmpty"){
        std::lock_guard<std::mutex> lock(guard);
        ok=nativeUiInventory.sendEmptyInventory(state==3&&client,[](const std::array<unsigned char,5>& bytes){
            RakNet::BitStream output;output.Write(reinterpret_cast<const char*>(bytes.data()),int(bytes.size()));
            return client->Send(&output,HIGH_PRIORITY,RELIABLE_ORDERED,5);
        });
    }else if(command=="connect"){
        int port;if(data(0)&&(in>>port)&&data(1)&&data(2))
            {cloudNativeUiReset();ok=Java_org_rakmagic_android_NativeBridge_connect(&env,nullptr,&values[0],port,&values[1],&values[2]);}
    }else if(command=="disconnect"){
        Java_org_rakmagic_android_NativeBridge_disconnect(&env,nullptr);status();ok=true;
    }else if(command=="spawn")ok=Java_org_rakmagic_android_NativeBridge_spawn(&env,nullptr);
    else if(command=="pause"){
        int paused;if(in>>paused)ok=Java_org_rakmagic_android_NativeBridge_setPaused(&env,nullptr,paused!=0);
    }else if(command=="restorePause")ok=Java_org_rakmagic_android_NativeBridge_restorePaused(&env,nullptr);
    else if(command=="restoreMenuPause"){
        std::lock_guard<std::mutex> lock(guard);
        if(state==3&&client&&spawned&&!spectating&&std::chrono::steady_clock::now()-spawnedAt>=std::chrono::seconds(1)){
            clientPaused=true;ok=true;
        }
    }
    else if(command=="click"){
        int id,revision;if(in>>id>>revision)ok=Java_org_rakmagic_android_NativeBridge_clickTextdraw(&env,nullptr,id,revision);
    }else if(command=="reply"){
        int serial,id,yes,item;if((in>>serial>>id>>yes>>item)&&data(0))
            ok=Java_org_rakmagic_android_NativeBridge_reply(&env,nullptr,serial,id,yes!=0,item,&values[0]);
    }else if(command=="send"){
        if(data(0))ok=Java_org_rakmagic_android_NativeBridge_send(&env,nullptr,&values[0]);
    }else if(command=="cancelSelection")ok=Java_org_rakmagic_android_NativeBridge_cancelTextdrawSelection(&env,nullptr);
    else if(command=="autoSpawn"){
        int enabled;if((in>>enabled)&&enabled==0&&data(0))ok=Java_org_rakmagic_android_NativeBridge_configureAutoSpawn(&env,nullptr,false,&values[0]);
    }else if(command=="quit"){stopping=1;ok=true;}
    response(id,ok);return true;
}
void status(){
    std::lock_guard<std::mutex> lock(guard);
    const bool mapKnown=state==3&&positionSequence>0&&std::isfinite(position[0])&&std::isfinite(position[1])&&std::isfinite(position[2])&&std::abs(position[0])<=100000&&std::abs(position[1])<=100000&&std::abs(position[2])<=100000;
    std::ostringstream mapValue;mapValue.precision(9);
    if(mapKnown)mapValue<<"["<<position[0]<<","<<position[1]<<","<<position[2]<<"]";else mapValue<<"null";
    std::cout<<"{\"type\":\"workerStatus\",\"state\":"<<state<<",\"spawned\":"<<(spawned?"true":"false")
        <<",\"paused\":"<<(clientPaused?"true":"false")<<",\"interior\":"<<(interiorKnown?int(interiorId):-1)
        <<",\"mapPositionKnown\":"<<(mapKnown?"true":"false")<<",\"mapPositionRevision\":"<<positionSequence<<",\"mapPosition\":"<<mapValue.str()
        <<",\"connectionDiagnostic\":"<<connectionDiagnostics.json(state)
        <<",\"launcherCompatibility\":"<<pcCompatibility.json()<<",\"nativeUiTransport\":"<<cloudNativeUiTransport()
        <<",\"uiInventoryProbe\":"<<nativeUiInventory.json()<<"}\n";
}
}
int main(){
    signal(SIGTERM,stopSignal);signal(SIGINT,stopSignal);
    std::cout.setf(std::ios::unitbuf);
    std::string input;auto lastStatus=std::chrono::steady_clock::now();
    autoSpawnEnabled=false;
    std::cout<<"{\"type\":\"workerReady\",\"version\":\"native-ui-0.6.8\",\"connectionDiagnostics\":true,\"afkOnly\":true,\"serverMenus\":false,\"accountMap\":true,\"launcherCompatibility\":false,\"packetInventory\":true,\"uiInventoryProbe\":true,\"nativeUiObserver\":true,\"readOnlyUi\":true}\n";
    while(!stopping){
        pollfd fd{STDIN_FILENO,POLLIN,0};int count=poll(&fd,1,20);
        if(count>0&&(fd.revents&(POLLIN|POLLHUP))){
            char chunk[4096];ssize_t length=read(STDIN_FILENO,chunk,sizeof(chunk));
            if(length<=0)break;
            input.append(chunk,size_t(length));
            if(input.size()>65536)break;
            size_t newline;
            while((newline=input.find('\n'))!=std::string::npos){
                std::string line=input.substr(0,newline);input.erase(0,newline+1);
                if(line.size()>16384||!execute(line))std::cout<<"{\"type\":\"workerError\",\"text\":\"Comando no valido\"}\n";
                if(stopping)break;
            }
        }
        Java_org_rakmagic_android_NativeBridge_tick(&env,nullptr);
        while(auto event=Java_org_rakmagic_android_NativeBridge_popEvent(&env,nullptr)){
            std::cout.write(reinterpret_cast<char*>(event->data()),event->size());std::cout<<'\n';delete event;
        }
        auto now=std::chrono::steady_clock::now();
        if(now-lastStatus>std::chrono::milliseconds(500)){status();lastStatus=now;}
    }
    Java_org_rakmagic_android_NativeBridge_disconnect(&env,nullptr);
    return 0;
}
