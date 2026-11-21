#include "main.h"
#include <jni.h>
#include <array>
#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <deque>
#include <cstdlib>
#include <mutex>
#include <random>
#include <string>
#include "RakNetworkFactory.h"
#include "RakClientInterface.h"
#include "PacketEnumerations.h"
#include "BitStream.h"
#include "StringCompressor.h"
#include "SAMP/SAMPRPC.h"
#include "PluginInterface.h"
#include "ConnectionDiagnostics.h"
#include "NgPcCompatibility.h"

extern char AuthKeyTable[512][2][128];
namespace {
std::mutex guard;
RakClientInterface* client = nullptr;
ConnectionDiagnostics connectionDiagnostics;
ngpc::Compatibility pcCompatibility;
static_assert(HIGH_PRIORITY == 1 && RELIABLE_ORDERED == 9, "Unexpected RakNet transport enumeration");
bool pcCompatibilitySendBits(const std::vector<uint8_t>& bytes, size_t bitCount) {
    if (!client || bytes.empty() || !bitCount || bitCount > bytes.size() * 8) return false;
    RakNet::BitStream output;
    output.WriteBits(bytes.data(), int(bitCount), false);
    return client->Send(&output, HIGH_PRIORITY, RELIABLE_ORDERED, 0);
}
bool pcCompatibilitySend(const std::vector<uint8_t>& bytes) {
    return pcCompatibilitySendBits(bytes, bytes.size() * 8);
}
class DiagnosticObserver final : public PluginInterface {
    PluginReceiveResult OnReceive(RakPeerInterface*,Packet* packet) override {
        connectionDiagnostics.observe(packet);
        return RR_CONTINUE_PROCESSING;
    }
} diagnosticObserver;
int state = 0; // 0 offline, 1 connecting, 2 transport accepted, 3 game initialized
bool spawned = false, spawnPending = false;
bool clientPaused = false;
bool classPending = false, classSelectable = false, spawnInfoReady = false;
bool autoSpawnEnabled = true, autoSpawnAttempted = false, loginMessageSeen = false;
bool spectating = false, serverSpawnAuthorized = false;
int classCount = 0;
std::string loginMessage;
struct SpawnData {
    bool ready = false;
    float pos[3]{}, quat[4]{1,0,0,0};
    uint64_t sequence = 0;
};
SpawnData explicitSpawn, classSpawn;
uint64_t poseSequence = 0, positionSequence = 0, angleSequence = 0;
uint64_t authorizationPoseSequence = 0, interactionPoseSequence = 0;
bool hadLoginInteraction = false;
uint16_t playerId = 0;
uint8_t interiorId = 0;
bool interiorKnown = false;
std::string nickname;
std::array<std::string,1004> names;
std::deque<std::string> events;
auto started = std::chrono::steady_clock::now();
auto lastSync = started;
auto lastScoresRequest = started;
auto spawnRequestedAt = started;
auto spawnedAt = started;
uint32_t dialogSerial = 0;
int dialogId = -1;
constexpr size_t TEXTDRAW_COUNT = 2048 + 256;
std::array<uint32_t,TEXTDRAW_COUNT> textdrawRevisions{};
std::array<bool,TEXTDRAW_COUNT> textdrawSelectable{};
uint32_t textdrawRevision = 0;
bool selectingTextdraws = false;
float position[3]{}, rotation[4]{1,0,0,0}, health=100, armour=0;

std::string quote(const std::string& s) {
    std::string out="\"";
    char buf[7];
    for (unsigned char c:s) {
        if (c=='"' || c=='\\') {out+='\\'; out+=c;}
        else if (c<32) {std::snprintf(buf,sizeof(buf),"\\u%04x",c); out+=buf;}
        else out+=c;
    }
    return out+'"';
}
void emit(std::string value) {
    // Bounded queue: a noisy server must not grow memory indefinitely.
    if(events.size()>=4096) events.pop_front();
    events.push_back(std::move(value));
}
void log(const std::string& s) { emit("{\"type\":\"log\",\"text\":"+quote(s)+"}"); }
void spawnStatus(const std::string& s){emit("{\"type\":\"spawnStatus\",\"text\":"+quote(s)+"}");}
std::string normalized(const std::string& s) {
    std::string out;bool space=false;
    for(size_t i=0;i<s.size();i++){
        if(s[i]=='{'&&i+7<s.size()&&s[i+7]=='}'){
            bool color=true;for(size_t j=i+1;j<i+7;j++)color&=std::isxdigit(static_cast<unsigned char>(s[j]))!=0;
            if(color){i+=7;continue;}
        }
        unsigned char c=s[i];
        if(std::isspace(c)){space=!out.empty();continue;}
        if(space){out+=' ';space=false;}
        out+=static_cast<char>(c<128?std::tolower(c):c);
    }
    return out;
}
void observeLauncherNotice(const std::string& text) {
    const auto notice=normalized(text);
    if(notice.find("launcher")!=std::string::npos
       &&(notice.find("obligatorio")!=std::string::npos||notice.find("expulsado")!=std::string::npos))
        connectionDiagnostics.launcherNotice=true;
}
void setState(int value, const std::string& label) {
    state=value;
    emit("{\"type\":\"state\",\"state\":"+std::to_string(value)+",\"text\":"+quote(label)+"}");
}
RakNet::BitStream stream(RPCParameters* p) {
    return RakNet::BitStream(p->input,(p->numberOfBitsOfData+7)/8,false);
}
bool string8(RakNet::BitStream& b, std::string& result) {
    uint8_t length;
    if(!b.Read(length)) return false;
    result.resize(length);
    return length==0 || b.Read(result.data(),length);
}
bool rpc(int& id, RakNet::BitStream& b) {
    return client->RPC(&id,&b,HIGH_PRIORITY,RELIABLE_ORDERED,0,false,UNASSIGNED_NETWORK_ID,nullptr);
}
void disconnect() {
    if(client) {client->Disconnect(100); RakNetworkFactory::DestroyRakClientInterface(client); client=nullptr;}
    clientPaused=false; state=0; spawned=spawnPending=classPending=classSelectable=spawnInfoReady=false; dialogId=-1;
    spectating=serverSpawnAuthorized=autoSpawnAttempted=loginMessageSeen=false;classCount=0;
    explicitSpawn=SpawnData{};classSpawn=SpawnData{};poseSequence=positionSequence=angleSequence=0;
    authorizationPoseSequence=interactionPoseSequence=0;hadLoginInteraction=false;
    interiorId=0;interiorKnown=false;
    selectingTextdraws=false;textdrawRevisions.fill(0);textdrawSelectable.fill(false);
}
void initGame(RPCParameters* p) {
    auto b=stream(p);
    bool flag;
    float f;
    int32_t integer;
    uint8_t byte;
    // Read the 0.3.7 InitGame layout; do not assume truncated RPCs are valid.
    for(int i=0;i<4;i++) if(!b.ReadCompressed(flag)) return;
    if(!b.Read(f) || !b.ReadCompressed(flag) || !b.Read(f)) return;
    for(int i=0;i<3;i++) if(!b.ReadCompressed(flag)) return;
    if(!b.Read(integer) || !b.Read(playerId) || playerId>=names.size()) return;
    classCount=std::max(0,integer);
    if(!b.ReadCompressed(flag) || !b.Read(integer) || !b.Read(byte) || !b.Read(byte) || !b.Read(f)
       || !b.ReadCompressed(flag) || !b.Read(integer) || !b.ReadCompressed(flag)) return;
    uint32_t ignored;
    for(int i=0;i<4;i++) if(!b.Read(ignored)) return;
    if(!b.Read(byte)) return; // lag compensation
    for(int i=0;i<3;i++) if(!b.Read(byte)) return;
    std::string hostname;
    if(!string8(b,hostname)) return;
    names[playerId]=nickname;
    connectionDiagnostics.gameInitialized=true;
    setState(3,"Conectado: "+hostname);
    spawnStatus("Esperando la orden de aparicion del servidor.");
    // The desktop client requests its first class even when InitGame reports
    // zero classes. Some gamemodes start their login UI from this callback.
    RakNet::BitStream request;request.Write(int32_t(0));rpc(RPC_RequestClass,request);
    lastScoresRequest=std::chrono::steady_clock::now()-std::chrono::seconds(3);
}
void message(RPCParameters* p) {
    auto b=stream(p);
    uint32_t color,length;
    if(!b.Read(color)||!b.Read(length)||length>4096) return;
    std::string text(length,'\0');
    if(length && !b.Read(text.data(),length)) return;
    observeLauncherNotice(text);
    char prefix[9];std::snprintf(prefix,sizeof(prefix),"{%06X}",static_cast<unsigned>(color>>8));
    log(std::string(prefix)+text);
    if(autoSpawnEnabled&&!loginMessage.empty()&&!autoSpawnAttempted&&state==3
       &&normalized(text).find(loginMessage)!=std::string::npos){
        loginMessageSeen=true;
        log("Mensaje de acceso completado detectado; esperando los datos de aparicion del servidor.");
        spawnStatus("Acceso detectado; esperando la ubicacion del servidor.");
    }
}
void chat(RPCParameters* p) {
    auto b=stream(p); uint16_t id; std::string text;
    if(!b.Read(id)||id>=names.size()||!string8(b,text)) return;
    log((names[id].empty()?"Jugador "+std::to_string(id):names[id])+": "+text);
}
void join(RPCParameters* p) {
    auto b=stream(p);uint16_t id;uint32_t color;uint8_t npc;std::string name;
    if(!b.Read(id)||id>=names.size()||!b.Read(color)||!b.Read(npc)||!string8(b,name)) return;
    names[id]=name;
}
void quit(RPCParameters* p) {auto b=stream(p);uint16_t id;if(b.Read(id)&&id<names.size())names[id].clear();}
void dialog(RPCParameters* p) {
    auto b=stream(p);int16_t id;uint8_t style;std::string title,yes,no;
    if(!b.Read(id)||!b.Read(style)||style>5||!string8(b,title)||!string8(b,yes)||!string8(b,no))return;
    dialogId=id;
    dialogSerial++;
    if(id<0) {emit("{\"type\":\"closeDialog\"}");return;}
    char body[8193]{};
    if(!stringCompressor->DecodeString(body,sizeof(body),&b)) {dialogId=-1;return;}
    observeLauncherNotice(title+" "+body);
    emit("{\"type\":\"dialog\",\"serial\":"+std::to_string(dialogSerial)+",\"id\":"+std::to_string(id)+
        ",\"style\":"+std::to_string(style)+",\"title\":"+quote(title)+",\"yes\":"+quote(yes)+
        ",\"no\":"+quote(no)+",\"body\":"+quote(body)+"}");
}
bool string16(RakNet::BitStream& b,std::string& text) {
    uint16_t length;
    if(!b.Read(length)||length>1024)return false;
    text.resize(length);return length==0||b.Read(text.data(),length);
}
bool finiteFloat(RakNet::BitStream& b,float& value) {
    return b.Read(value)&&std::isfinite(value)&&std::abs(value)<=100000.f;
}
void showTextdraw(RPCParameters* p) {
    auto b=stream(p);
    uint16_t id,model;uint8_t flags,shadow,outline,style,selectable;
    uint32_t color,boxColor,background;
    float lx,ly,tx,ty,x,y,ignored;
    int16_t c1,c2;std::string text;
    if(!b.Read(id)||id>=TEXTDRAW_COUNT||!b.Read(flags)||!finiteFloat(b,lx)||!finiteFloat(b,ly)
       ||!b.Read(color)||!finiteFloat(b,tx)||!finiteFloat(b,ty)||!b.Read(boxColor)
       ||!b.Read(shadow)||!b.Read(outline)||!b.Read(background)||!b.Read(style)||style>5
       ||!b.Read(selectable)||selectable>1||!finiteFloat(b,x)||!finiteFloat(b,y)||!b.Read(model))return;
    for(int i=0;i<4;i++)if(!finiteFloat(b,ignored))return;
    if(!b.Read(c1)||!b.Read(c2)||!string16(b,text))return;
    observeLauncherNotice(text);
    textdrawRevisions[id]=++textdrawRevision;textdrawSelectable[id]=selectable;
    emit("{\"type\":\"textdraw\",\"id\":"+std::to_string(id)+",\"revision\":"+std::to_string(textdrawRevision)+
         ",\"flags\":"+std::to_string(flags)+",\"lx\":"+std::to_string(lx)+",\"ly\":"+std::to_string(ly)+
         ",\"tx\":"+std::to_string(tx)+",\"ty\":"+std::to_string(ty)+",\"x\":"+std::to_string(x)+",\"y\":"+std::to_string(y)+
         ",\"color\":"+std::to_string(color)+",\"boxColor\":"+std::to_string(boxColor)+",\"background\":"+std::to_string(background)+
         ",\"shadow\":"+std::to_string(shadow)+",\"outline\":"+std::to_string(outline)+",\"style\":"+std::to_string(style)+
         ",\"model\":"+std::to_string(model)+",\"selectable\":"+(selectable?"true":"false")+",\"text\":"+quote(text)+"}");
}
void hideTextdraw(RPCParameters* p) {
    auto b=stream(p);uint16_t id;if(!b.Read(id)||id>=TEXTDRAW_COUNT)return;
    textdrawRevisions[id]=0;textdrawSelectable[id]=false;
    emit("{\"type\":\"hideTextdraw\",\"id\":"+std::to_string(id)+"}");
}
void editTextdraw(RPCParameters* p) {
    auto b=stream(p);uint16_t id;std::string text;
    if(!b.Read(id)||id>=TEXTDRAW_COUNT||!string16(b,text)||!textdrawRevisions[id])return;
    observeLauncherNotice(text);
    textdrawRevisions[id]=++textdrawRevision;
    emit("{\"type\":\"editTextdraw\",\"id\":"+std::to_string(id)+",\"revision\":"+std::to_string(textdrawRevision)+",\"text\":"+quote(text)+"}");
}
void selectTextdraw(RPCParameters* p) {
    auto b=stream(p);bool enabled;uint32_t color;
    if(!b.Read(enabled)||!b.Read(color))return;
    selectingTextdraws=enabled;
    emit(std::string("{\"type\":\"selectTextdraw\",\"enabled\":")+(enabled?"true":"false")+",\"color\":"+std::to_string(color)+"}");
}
void setPosition(RPCParameters* p) {
    auto b=stream(p);float pos[3];
    for(float& f:pos)if(!b.Read(f)||!std::isfinite(f))return;
    std::copy(pos,pos+3,position);
    positionSequence=++poseSequence;
}
void setInterior(RPCParameters* p) {
    // SA-MP RPC156 supplies an unsigned byte. RPC118 confirms it to the server,
    // which owns interior-dependent callbacks and the player's virtual world.
    // Never infer a virtual-world ID from an interior or report an implicit 0
    // on spawn. Each fresh connection waits for its server's current order.
    if(p->numberOfBitsOfData<8)return;
    auto b=stream(p);uint8_t value;if(!b.Read(value))return;
    bool changed=!interiorKnown||interiorId!=value;
    interiorId=value;interiorKnown=true;
    RakNet::BitStream confirmation;confirmation.Write(interiorId);
    rpc(RPC_SetInteriorId,confirmation);
    if(changed)log("Interior indicado por el servidor: "+std::to_string(interiorId)+".");
}
void setHealth(RPCParameters* p) {auto b=stream(p);float v;if(b.Read(v)&&std::isfinite(v))health=std::clamp(v,0.f,100.f);}
void setArmour(RPCParameters* p) {auto b=stream(p);float v;if(b.Read(v)&&std::isfinite(v))armour=std::clamp(v,0.f,100.f);}
void angleQuat(float angle,float* target) {
    angle*=3.14159265f/360.f;
    target[0]=std::cos(angle);target[1]=target[2]=0;target[3]=-std::sin(angle);
}
void setAngle(RPCParameters* p){auto b=stream(p);float angle;if(b.Read(angle)&&std::isfinite(angle)){angleQuat(angle,rotation);angleSequence=++poseSequence;}}
bool spawnInfo(RakNet::BitStream& b,SpawnData& target) {
    uint8_t team;int32_t skin;uint8_t unknown;float pos[3],angle;
    if(!b.Read(team)||!b.Read(skin)||!b.Read(unknown))return false;
    for(float& f:pos)if(!b.Read(f)||!std::isfinite(f))return false;
    if(!b.Read(angle)||!std::isfinite(angle))return false;
    uint32_t weaponOrAmmo;
    for(int i=0;i<6;i++)if(!b.Read(weaponOrAmmo))return false;
    std::copy(pos,pos+3,target.pos);angleQuat(angle,target.quat);
    target.ready=true;target.sequence=++poseSequence;spawnInfoReady=true;return true;
}
void setSpawn(RPCParameters* p){auto b=stream(p);if(spawnInfo(b,explicitSpawn))log("Datos de aparicion recibidos del servidor.");}
void requestSpawn() {
    classPending=false;spawnRequestedAt=std::chrono::steady_clock::now();
    RakNet::BitStream empty;rpc(RPC_RequestSpawn,empty);
    log("Aparicion solicitada; esperando autorizacion del servidor.");
    spawnStatus("Esperando autorizacion para aparecer.");
}
void classReply(RPCParameters* p){
    auto b=stream(p);uint8_t allowed;
    if(!b.Read(allowed)||allowed>1)return;
    if(!allowed){
        classSelectable=false;
        if(classPending){classPending=spawnPending=false;}
        log("El servidor no permite seleccionar la clase todavia. Completa el login o la pantalla del servidor.");
        return;
    }
    if(!spawnInfo(b,classSpawn)){
        classSelectable=false;
        if(classPending){classPending=spawnPending=false;}
        log("Respuesta de clase incompleta; no se solicito la aparicion.");return;
    }
    classSelectable=true;log("Clase 0 aceptada y datos de aparicion recibidos.");
    if(classPending&&spawnPending)requestSpawn();
}
void completeSpawn(){
    const SpawnData& data=explicitSpawn.ready?explicitSpawn:classSpawn;
    if(!data.ready)return;
    uint64_t resetSequence=std::max(data.sequence,authorizationPoseSequence);
    if(positionSequence<=resetSequence){std::copy(data.pos,data.pos+3,position);positionSequence=resetSequence;}
    if(angleSequence<=resetSequence){std::copy(data.quat,data.quat+4,rotation);angleSequence=resetSequence;}
    RakNet::BitStream empty;rpc(RPC_Spawn,empty);
    connectionDiagnostics.spawnSent=true;
    spawned=true;spectating=false;serverSpawnAuthorized=spawnPending=classPending=false;
    autoSpawnAttempted=true;loginMessageSeen=false;spawnedAt=lastSync=std::chrono::steady_clock::now();
    char location[180];std::snprintf(location,sizeof(location),"Aparicion autorizada; Spawn enviado en %.3f, %.3f, %.3f. Esperando los mensajes del servidor.",position[0],position[1],position[2]);
    log(location);spawnStatus("Spawn enviado con la ubicacion del servidor.");
}
void authorizeSpawn(){
    // A spectator-disable and Allow=2 can describe the same transition.
    if(spawned&&!spectating&&std::chrono::steady_clock::now()-spawnedAt<std::chrono::seconds(1))return;
    if(!serverSpawnAuthorized)authorizationPoseSequence=poseSequence;
    serverSpawnAuthorized=true;spawnPending=classPending=false;spawnRequestedAt=std::chrono::steady_clock::now();
    spawnStatus(spawnInfoReady?"El servidor ordeno aparecer.":"El servidor ordeno aparecer; esperando sus datos de ubicacion.");
}
void toggleSpectating(RPCParameters* p){
    auto b=stream(p);uint32_t enabled;if(!b.Read(enabled)||enabled>1)return;
    if(enabled){
        spectating=true;spawned=false;serverSpawnAuthorized=spawnPending=classPending=false;
        loginMessageSeen=false;autoSpawnAttempted=false;
        spawnStatus("En modo espectador; esperando que el servidor termine el acceso.");
    }else{
        bool wasSpectating=spectating;spectating=false;
        if(wasSpectating||!spawned)authorizeSpawn();
    }
}
void spawnReply(RPCParameters* p){
    auto b=stream(p);uint32_t allowed;
    if(!b.Read(allowed)||allowed>2||(allowed!=2&&(!spawnPending||classPending)))return;
    spawnPending=classPending=false;
    if(!allowed){log("El servidor no autorizo la aparicion.");spawnStatus("Aparicion rechazada por el servidor. Reintento manual disponible.");return;}
    if(allowed==2)spectating=false; // SpawnPlayer also ends spectating without RPC124.
    authorizeSpawn();
}
void rejected(RPCParameters* p){auto b=stream(p);uint8_t reason;if(b.Read(reason))log("Acceso rechazado por el servidor. Motivo "+std::to_string(reason));connectionDiagnostics.end=ConnectionDiagnostics::End::Rejected;setState(0,"Acceso rechazado");}
void registerCallbacks(){
    auto registerRPC=[](int& id,void(*callback)(RPCParameters*)) {
        connectionDiagnostics.handler(id);
        client->RegisterAsRemoteProcedureCall(&id,callback);
    };
    registerRPC(RPC_InitGame,initGame);
    registerRPC(RPC_ClientMessage,message);
    registerRPC(RPC_Chat,chat);
    registerRPC(RPC_ServerJoin,join);
    registerRPC(RPC_ServerQuit,quit);
    registerRPC(RPC_ScrDialogBox,dialog);
    registerRPC(RPC_ScrShowTextDraw,showTextdraw);
    registerRPC(RPC_ScrHideTextDraw,hideTextdraw);
    registerRPC(RPC_ScrEditTextDraw,editTextdraw);
    registerRPC(RPC_ClickTextDraw,selectTextdraw);
    registerRPC(RPC_ScrSetPlayerPos,setPosition);
    registerRPC(RPC_ScrSetInterior,setInterior);
    registerRPC(RPC_ScrSetPlayerFacingAngle,setAngle);
    registerRPC(RPC_ScrSetPlayerHealth,setHealth);
    registerRPC(RPC_ScrSetPlayerArmour,setArmour);
    registerRPC(RPC_ScrSetSpawnInfo,setSpawn);
    registerRPC(RPC_ScrTogglePlayerSpectating,toggleSpectating);
    registerRPC(RPC_RequestClass,classReply);
    registerRPC(RPC_RequestSpawn,spawnReply);
    registerRPC(RPC_ConnectionRejected,rejected);
    registerRPC(RPC_UpdateScoresPingsIPs,[](RPCParameters*){});
}
void authorize(Packet* p){
    if(p->length<2 || p->data[1]>p->length-2)return;
    std::string key(reinterpret_cast<char*>(p->data+2),p->data[1]);
    if(!key.empty()&&key.back()=='\0')key.pop_back();
    for(auto& pair:AuthKeyTable){
        if(key!=pair[0])continue;
        RakNet::BitStream b;b.Write(uint8_t(ID_AUTH_KEY));b.Write(uint8_t(std::strlen(pair[1])));
        b.Write(pair[1],std::strlen(pair[1]));client->Send(&b,SYSTEM_PRIORITY,RELIABLE,0);return;
    }
    connectionDiagnostics.end=ConnectionDiagnostics::End::Authentication;
    log("Clave de autenticacion no compatible con esta version.");
    setState(0,"Autenticacion no compatible");
}
void accepted(Packet* p){
    RakNet::BitStream b(p->data,p->length,false);
    uint32_t address,challenge;uint16_t port;uint8_t type;
    if(!b.Read(type)||!b.Read(address)||!b.Read(port)||!b.Read(playerId)||!b.Read(challenge))return;
    // A per-session protocol identifier divisible by 1001, as required by SA-MP.
    // Fixed-size bytes avoid the Windows unsigned-long/Android LP64 difference.
    std::random_device random;
    const char* hex="0123456789ABCDEF";
    std::array<uint8_t,24> number{};
    for(int i=4;i<24;i++)number[i]=uint8_t(random());
    uint32_t carry=0;
    for(int i=23;i>=0;i--){uint32_t product=number[i]*1001u+carry;number[i]=uint8_t(product);carry=product>>8;}
    std::string identifier;
    for(uint8_t byte:number){identifier+=hex[byte>>4];identifier+=hex[byte&15];}
    auto first=identifier.find_first_not_of('0');identifier=first==std::string::npos?"0":identifier.substr(first);
    connectionDiagnostics.transportAccepted=true;
    const std::string version="0.3.7";
    RakNet::BitStream out;
    out.Write(uint32_t(4057));out.Write(uint8_t(1));out.Write(uint8_t(nickname.size()));out.Write(nickname.data(),nickname.size());
    out.Write(uint32_t(challenge^4057));out.Write(uint8_t(identifier.size()));out.Write(identifier.data(),identifier.size());
    out.Write(uint8_t(version.size()));out.Write(version.data(),version.size());connectionDiagnostics.joinSent=rpc(RPC_ClientJoin,out);
    setState(2,"Conexion aceptada; esperando al servidor");
    pcCompatibility.connected(pcCompatibilitySend, pcCompatibilitySendBits);
}
void sync(){
    // Write every field explicitly: Android 64-bit padding must never affect the wire format.
    RakNet::BitStream b;b.Write(uint8_t(ID_PLAYER_SYNC));
    for(int i=0;i<3;i++)b.Write(uint16_t(0));
    for(float f:position)b.Write(f);
    for(float f:rotation)b.Write(f);
    b.Write(uint8_t(health));b.Write(uint8_t(armour));b.Write(uint8_t(0));b.Write(uint8_t(0));
    for(int i=0;i<6;i++)b.Write(0.f);
    b.Write(uint16_t(0));b.Write(uint16_t(0));b.Write(uint16_t(0));
    client->Send(&b,HIGH_PRIORITY,UNRELIABLE_SEQUENCED,0);
}
std::string bytes(JNIEnv* env,jbyteArray value){
    if(!value)return {};
    auto n=env->GetArrayLength(value);std::string s(n,'\0');
    env->GetByteArrayRegion(value,0,n,reinterpret_cast<jbyte*>(s.data()));return s;
}
}
extern "C" JNIEXPORT jboolean JNICALL Java_org_rakmagic_android_NativeBridge_connect(JNIEnv* e,jclass,jbyteArray host,jint port,jbyteArray name,jbyteArray password){
    std::lock_guard<std::mutex> lock(guard);disconnect();events.clear();names.fill("");
    auto addr=bytes(e,host);nickname=bytes(e,name);auto pass=bytes(e,password);
    if(addr.empty()||addr.size()>253||port<1||port>65535||nickname.size()<3||nickname.size()>24||pass.size()>128||addr.find('\0')!=std::string::npos||nickname.find('\0')!=std::string::npos||pass.find('\0')!=std::string::npos)return false;
    position[0]=position[1]=position[2]=0;rotation[0]=1;rotation[1]=rotation[2]=rotation[3]=0;health=100;armour=0;
    connectionDiagnostics.reset();
    const char* compatibilityOption = std::getenv("RAKMAGIC_NG_COMPAT");
#ifdef RAKMAGIC_PASSIVE_UI_ONLY
    pcCompatibility.reset(false);
#else
    pcCompatibility.reset(compatibilityOption && std::strcmp(compatibilityOption,"1")==0);
#endif
    client=RakNetworkFactory::GetRakClientInterface();client->AttachPlugin(&diagnosticObserver);client->SetMTUSize(576);registerCallbacks();client->SetPassword(pass.c_str());
    started=std::chrono::steady_clock::now();lastSync=lastScoresRequest=started;
    setState(1,"Conectando a "+addr+":"+std::to_string(port));
    if(!client->Connect(addr.c_str(),port,0,0,10)){connectionDiagnostics.end=ConnectionDiagnostics::End::Failed;disconnect();setState(0,"No se pudo iniciar la conexion UDP del dispositivo.");return false;}
    return true;
}
extern "C" JNIEXPORT void JNICALL Java_org_rakmagic_android_NativeBridge_disconnect(JNIEnv*,jclass){std::lock_guard<std::mutex> lock(guard);if(connectionDiagnostics.end==ConnectionDiagnostics::End::None&&connectionDiagnostics.attempted)connectionDiagnostics.end=ConnectionDiagnostics::End::Local;disconnect();setState(0,"Desconectado");}
extern "C" JNIEXPORT jint JNICALL Java_org_rakmagic_android_NativeBridge_tick(JNIEnv*,jclass){
    std::lock_guard<std::mutex> lock(guard);if(!client)return state;
    int count=0;
    while(count++<128){
        Packet* p=client->Receive();if(!p)break;
        if(p->length){
            uint8_t id=p->data[0];
            // Observe only the opt-in extension. Keep ordinary SA-MP handling
            // and authentication independent of this experimental exchange.
            size_t extensionOffset = 0;
            if (id == ID_TIMESTAMP) extensionOffset = 1 + sizeof(RakNetTime);
            if (extensionOffset < p->length) {
                const size_t consumedBits = extensionOffset * 8;
                if (!p->bitSize || p->bitSize >= consumedBits) {
#ifdef RAKMAGIC_NATIVE_UI_OBSERVE
                    RAKMAGIC_NATIVE_UI_OBSERVE(p->data + extensionOffset, p->length - extensionOffset);
#endif
                    pcCompatibility.receive(p->data + extensionOffset, p->length - extensionOffset,
                        p->bitSize ? p->bitSize - consumedBits : 0, pcCompatibilitySend);
                }
            }
            switch(id){
            case ID_AUTH_KEY:authorize(p);break;
            case ID_CONNECTION_REQUEST_ACCEPTED:accepted(p);break;
            case ID_DISCONNECTION_NOTIFICATION:connectionDiagnostics.end=ConnectionDiagnostics::End::Server;setState(0,"El servidor cerro la conexion");break;
            case ID_CONNECTION_BANNED:connectionDiagnostics.end=ConnectionDiagnostics::End::Banned;setState(0,"Conexion bloqueada por el servidor");break;
            case ID_CONNECTION_ATTEMPT_FAILED:connectionDiagnostics.end=ConnectionDiagnostics::End::Failed;setState(0,"No hubo respuesta del servidor");break;
            case ID_NO_FREE_INCOMING_CONNECTIONS:connectionDiagnostics.end=ConnectionDiagnostics::End::Full;setState(0,"Servidor lleno");break;
            case ID_INVALID_PASSWORD:connectionDiagnostics.end=ConnectionDiagnostics::End::Password;setState(0,"Clave del servidor incorrecta");break;
            case ID_CONNECTION_LOST:connectionDiagnostics.end=ConnectionDiagnostics::End::Lost;setState(0,"Conexion perdida");break;
            }
        }
        client->DeallocatePacket(p);
        if(state==0)break;
    }
    auto now=std::chrono::steady_clock::now();
    if(state>0&&state<3&&now-started>std::chrono::seconds(30)){connectionDiagnostics.end=ConnectionDiagnostics::End::Timeout;setState(0,"Tiempo de espera agotado");}
    if(state==0){disconnect();return 0;}
    // This is the desktop's normal scoreboard/ping refresh. Keep it running
    // while AFK; pausing the character must not suspend the RakNet session.
    if(state==3&&now-lastScoresRequest>=std::chrono::seconds(3)){
        RakNet::BitStream empty;rpc(RPC_UpdateScoresPingsIPs,empty);lastScoresRequest=now;
    }
    if(spawnPending&&now-spawnRequestedAt>std::chrono::seconds(10)){
        log(classPending?"Sin respuesta a la seleccion de clase. Puedes volver a pulsar Aparecer.":"Sin respuesta a la solicitud de aparicion. Puedes volver a pulsar Aparecer.");
        spawnPending=classPending=false;
        spawnStatus("Sin respuesta del servidor. Reintento manual disponible.");
    }
    if(state==3&&serverSpawnAuthorized&&!spectating){
        if(spawnInfoReady)completeSpawn();
        else if(now-spawnRequestedAt>std::chrono::seconds(10)){
            serverSpawnAuthorized=false;
            log("No llegaron los datos de ubicacion tras la orden de aparicion. No se uso una posicion inventada.");
            spawnStatus("Faltan los datos de aparicion del servidor.");
        }
    }
    if(state==3&&autoSpawnEnabled&&loginMessageSeen&&!autoSpawnAttempted&&!spawned
       &&!spawnPending&&!serverSpawnAuthorized&&!spectating&&dialogId<0&&!selectingTextdraws&&spawnInfoReady){
        autoSpawnAttempted=true;spawnPending=true;
        log("Acceso completado detectado. Solicitando aparicion automatica con los datos del servidor.");
        requestSpawn();
    }
    if(state==3&&spawned&&!clientPaused&&now-lastSync>std::chrono::milliseconds(100)){sync();lastSync=now;}
    return state;
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_org_rakmagic_android_NativeBridge_popEvent(JNIEnv* e,jclass){
    std::lock_guard<std::mutex> lock(guard);if(events.empty())return nullptr;
    auto value=std::move(events.front());events.pop_front();auto result=e->NewByteArray(value.size());
    if(result)e->SetByteArrayRegion(result,0,value.size(),reinterpret_cast<const jbyte*>(value.data()));return result;
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_org_rakmagic_android_NativeBridge_connectionDiagnostics(JNIEnv* e,jclass){
    std::lock_guard<std::mutex> lock(guard);
    const auto value=connectionDiagnostics.json(state);
    auto result=e->NewByteArray(value.size());
    if(result)e->SetByteArrayRegion(result,0,value.size(),reinterpret_cast<const jbyte*>(value.data()));
    return result;
}
extern "C" JNIEXPORT jboolean JNICALL Java_org_rakmagic_android_NativeBridge_send(JNIEnv* e,jclass,jbyteArray text){
    std::lock_guard<std::mutex> lock(guard);if(state!=3||!client)return false;
    auto value=bytes(e,text);if(value.empty()||value.find('\0')!=std::string::npos)return false;
    RakNet::BitStream b;
    if(value[0]=='/'){if(value.size()>512)return false;b.Write(uint32_t(value.size()));b.Write(value.data(),value.size());rpc(RPC_ServerCommand,b);}
    else {if(value.size()>144)return false;b.Write(uint8_t(value.size()));b.Write(value.data(),value.size());rpc(RPC_Chat,b);}
    return true;
}
extern "C" JNIEXPORT jboolean JNICALL Java_org_rakmagic_android_NativeBridge_reply(JNIEnv* e,jclass,jint serial,jint id,jboolean yes,jint item,jbyteArray text){
    std::lock_guard<std::mutex> lock(guard);if(state!=3||!client||id!=dialogId||uint32_t(serial)!=dialogSerial||item< -1||item>32767)return false;
    auto value=bytes(e,text);if(value.size()>255||value.find('\0')!=std::string::npos)return false;
    if(yes){hadLoginInteraction=true;interactionPoseSequence=poseSequence;}
    RakNet::BitStream b;b.Write(uint16_t(id));b.Write(uint8_t(yes));b.Write(int16_t(item));b.Write(uint8_t(value.size()));b.Write(value.data(),value.size());rpc(RPC_DialogResponse,b);dialogId=-1;return true;
}
extern "C" JNIEXPORT jboolean JNICALL Java_org_rakmagic_android_NativeBridge_spawn(JNIEnv*,jclass){
    std::lock_guard<std::mutex> lock(guard);if(state!=3||!client)return false;
    if(spawned){log("Spawn ya enviado tras autorizacion. Si el personaje no aparece, copia los mensajes del servidor.");return false;}
    if(spawnPending||serverSpawnAuthorized){log("Ya hay una solicitud de aparicion pendiente; espera la respuesta del servidor.");return false;}
    if(spectating){log("El servidor mantiene el modo espectador. Completa el acceso y espera su orden de aparicion.");return false;}
    if(!spawnInfoReady&&classCount==0){log("El servidor aun no envio los datos de aparicion.");return false;}
    autoSpawnAttempted=true;
    spawnPending=true;spawnRequestedAt=std::chrono::steady_clock::now();
    if(!classSelectable&&(!explicitSpawn.ready||!hadLoginInteraction||explicitSpawn.sequence<=interactionPoseSequence)){
        classPending=true;RakNet::BitStream b;b.Write(int32_t(0));rpc(RPC_RequestClass,b);
        log("Solicitando clase 0 antes de pedir la aparicion.");
    }else requestSpawn();
    return true;
}
extern "C" JNIEXPORT jboolean JNICALL Java_org_rakmagic_android_NativeBridge_configureAutoSpawn(JNIEnv* e,jclass,jboolean enabled,jbyteArray phrase){
    std::lock_guard<std::mutex> lock(guard);auto text=bytes(e,phrase);
    if(text.size()>255||text.find('\0')!=std::string::npos)return false;
    auto value=normalized(text);if(!value.empty()&&value.size()<8)return false;
    if(autoSpawnEnabled!=bool(enabled)||loginMessage!=value)loginMessageSeen=false;
    autoSpawnEnabled=enabled;loginMessage=std::move(value);return true;
}
extern "C" JNIEXPORT jboolean JNICALL Java_org_rakmagic_android_NativeBridge_clickTextdraw(JNIEnv*,jclass,jint id,jint revision){
    std::lock_guard<std::mutex> lock(guard);
    if(state!=3||!client||!selectingTextdraws||id<0||id>=int(TEXTDRAW_COUNT)
       ||!textdrawSelectable[id]||!textdrawRevisions[id]||textdrawRevisions[id]!=uint32_t(revision))return false;
    RakNet::BitStream b;b.Write(uint16_t(id));rpc(RPC_ClickTextDraw,b);return true;
}
extern "C" JNIEXPORT jboolean JNICALL Java_org_rakmagic_android_NativeBridge_cancelTextdrawSelection(JNIEnv*,jclass){
    std::lock_guard<std::mutex> lock(guard);
    if(state!=3||!client||!selectingTextdraws)return false;
    RakNet::BitStream b;b.Write(uint16_t(0xffff));rpc(RPC_ClickTextDraw,b);
    selectingTextdraws=false;emit("{\"type\":\"selectTextdraw\",\"enabled\":false,\"color\":0}");return true;
}

extern "C" JNIEXPORT jboolean JNICALL Java_org_rakmagic_android_NativeBridge_setPaused(JNIEnv*,jclass,jboolean paused){
    std::lock_guard<std::mutex> lock(guard);
    if(state!=3||!client||(paused&&!spawned))return false;
    clientPaused=paused;
    if(!clientPaused&&spawned){sync();lastSync=std::chrono::steady_clock::now();}
    log(clientPaused?"Pausa AFK activada: sincronizacion del personaje detenida; conexion mantenida.":"Pausa AFK desactivada: sincronizacion reanudada.");
    return true;
}

extern "C" JNIEXPORT jboolean JNICALL Java_org_rakmagic_android_NativeBridge_restorePaused(JNIEnv*,jclass){
    std::lock_guard<std::mutex> lock(guard);
    if(state!=3||!client||!spawned||spectating||dialogId>=0||selectingTextdraws)return false;
    // Let the newly spawned character send its initial on-foot sync before
    // resuming the pause. This is a readiness check, not another spawn request.
    if(std::chrono::steady_clock::now()-spawnedAt<std::chrono::seconds(1))return false;
    if(!clientPaused){
        clientPaused=true;
        log("Pausa AFK restaurada automaticamente despues de reconectar.");
    }
    return true;
}
