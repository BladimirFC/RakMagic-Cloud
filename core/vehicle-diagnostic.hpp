// GPL-2.0-or-later. Entry diagnostics and a separately prepared short test.
void shortDriveStop(const char*);void shortDriveReset();void shortDriveAdd(int,int);void shortDriveLocate(int,const float*);void shortDriveRemove(int);void shortDriveStep(float*);std::string shortDriveJson();
extern KLRM::Obstacle::Sensor shortDriveSensor;
struct DiagnosticCheckpoint {bool active=false;float p[3]{},radius=0;unsigned long revision=0;} diagnosticCheckpoint;
void diagnosticCheckpointSet(RPCParameters* p){
    auto b=stream(p);float values[4];for(float& value:values)if(!b.Read(value)||!std::isfinite(value)||std::abs(value)>10000)return;
    if(values[3]<.5||values[3]>20||b.GetNumberOfUnreadBits()>7)return;
    ++diagnosticCheckpoint.revision;diagnosticCheckpoint.active=true;std::copy(values,values+3,diagnosticCheckpoint.p);diagnosticCheckpoint.radius=values[3];shortDriveStop("checkpoint-changed");
}
void checkpointRouteRemoved();
void diagnosticCheckpointOff(RPCParameters*){checkpointRouteRemoved();diagnosticCheckpoint.active=false;++diagnosticCheckpoint.revision;}
std::string diagnosticCheckpointJson(){return "{\"active\":"+std::string(diagnosticCheckpoint.active?"true":"false")+",\"revision\":"+std::to_string(diagnosticCheckpoint.revision)+",\"position\":["+std::to_string(diagnosticCheckpoint.p[0])+","+std::to_string(diagnosticCheckpoint.p[1])+","+std::to_string(diagnosticCheckpoint.p[2])+"],\"radius\":"+std::to_string(diagnosticCheckpoint.radius)+"}";}
struct DiagnosticCar {
    bool present=false,engineKnown=false,engine=false,locked=false;
    int model=0;float pos[3]{},angle=0,hp=1000;uint64_t revision=0;
};
std::array<DiagnosticCar,2000> diagnosticCars{};
uint64_t diagnosticRevision=0;
uint64_t diagnosticAdds=0,diagnosticRejected=0;std::string diagnosticRejectReason;
uint16_t diagnosticVehicle=0,diagnosticRequested=0;uint8_t diagnosticSeat=255;
// A normal SA-MP entry is initiated by the client and completed with driver
// sync. PutPlayerInVehicle is a separate server-forced path, not its ACK.
uint16_t diagnosticLocalVehicle=0;uint64_t diagnosticEntrySyncs=0;
std::string diagnosticEntryState="idle",diagnosticEntryReason;
auto diagnosticBoardAt=std::chrono::steady_clock::now();
int diagnosticParamsRPC=24;
void diagnosticCancel(){
    shortDriveStop("manual-stop");if(diagnosticRequested)diagnosticEntryState="cancelled";diagnosticRequested=0;
    // Flush a zero-velocity vehicle frame before AFK can suspend periodic sync.
    // With no active driver/passenger, diagnosticSync emits no vehicle frame.
    if(client&&state==3&&spawned&&!clientPaused)diagnosticSync();
}
void diagnosticClearEntry(const char* reason){
    shortDriveStop(reason);
    if(diagnosticRequested||diagnosticLocalVehicle||diagnosticVehicle){diagnosticEntryState="interrupted";diagnosticEntryReason=reason;}
    diagnosticVehicle=diagnosticRequested=diagnosticLocalVehicle=0;diagnosticSeat=255;
}
void diagnosticReset(){shortDriveReset();diagnosticCheckpoint=DiagnosticCheckpoint{};diagnosticCars.fill(DiagnosticCar{});diagnosticVehicle=diagnosticRequested=diagnosticLocalVehicle=0;diagnosticSeat=255;diagnosticAdds=diagnosticRejected=diagnosticEntrySyncs=0;diagnosticRejectReason.clear();diagnosticEntryState="idle";diagnosticEntryReason.clear();}
void diagnosticReject(const char* reason){++diagnosticRejected;diagnosticRejectReason=reason;}
void diagnosticPlayerMoved(){diagnosticClearEntry("server-position-correction");}
void diagnosticAdd(RPCParameters* p){
    ++diagnosticAdds;
    auto b=stream(p);uint16_t id;int32_t model;uint8_t c1,c2,interior;DiagnosticCar v;
    if(!b.Read(id)||!id||id>=diagnosticCars.size()||!b.Read(model)||model<400||model>611){diagnosticReject("vehicle-id-or-model");return;}
    shortDriveAdd(id,model);
    for(float& f:v.pos)if(!b.Read(f)||!std::isfinite(f)||std::abs(f)>10000){diagnosticReject("vehicle-position");return;}
    if(!b.Read(v.angle)||!std::isfinite(v.angle)){diagnosticReject("vehicle-angle");return;}
    if(!b.Read(c1)||!b.Read(c2)){diagnosticReject("vehicle-colours");return;}
    if(!b.Read(v.hp)||!std::isfinite(v.hp)||v.hp<0||v.hp>10000000){diagnosticReject("vehicle-health");return;}
    if(!b.Read(interior)){diagnosticReject("vehicle-interior");return;}
    v.present=true;v.model=model;v.revision=++diagnosticRevision;diagnosticCars[id]=v;
    shortDriveLocate(id,v.pos);
}
void diagnosticRemove(RPCParameters* p){
    auto b=stream(p);uint16_t id;if(!b.Read(id)||!id||id>=diagnosticCars.size())return;
    diagnosticCars[id]=DiagnosticCar{};
    shortDriveRemove(id);
    if(id==diagnosticRequested||id==diagnosticVehicle||id==diagnosticLocalVehicle)diagnosticClearEntry("vehicle-streamed-out");
}
void diagnosticPos(RPCParameters* p){
    auto b=stream(p);uint16_t id;float v[3];if(!b.Read(id)||!id||id>=diagnosticCars.size()||!diagnosticCars[id].present)return;
    for(float& f:v)if(!b.Read(f)||!std::isfinite(f)||std::abs(f)>10000)return;
    auto& car=diagnosticCars[id];std::copy(v,v+3,car.pos);car.revision=++diagnosticRevision;
    shortDriveLocate(id,v);
    if(id==diagnosticVehicle||id==diagnosticLocalVehicle)shortDriveStop("server-vehicle-position");
    if(id==diagnosticVehicle||id==diagnosticLocalVehicle)std::copy(v,v+3,position);
}
void diagnosticPut(RPCParameters* p){
    auto b=stream(p);uint16_t id;uint8_t seat;
    if(!b.Read(id)||!b.Read(seat)||!id||id>=diagnosticCars.size()||!diagnosticCars[id].present||seat>7)return;
    diagnosticVehicle=id;diagnosticSeat=seat;diagnosticRequested=diagnosticLocalVehicle=0;
    shortDriveStop("server-seat-change");
    diagnosticEntryState="server-assigned";diagnosticEntryReason.clear();
    std::copy(diagnosticCars[id].pos,diagnosticCars[id].pos+3,position);angleQuat(diagnosticCars[id].angle,rotation);
    emit("{\"type\":\"vehicleEntryConfirmed\",\"vehicle\":"+std::to_string(id)+",\"seat\":"+std::to_string(seat)+"}");
}
void diagnosticEject(RPCParameters*){diagnosticClearEntry("server-remove-player-from-vehicle");}
void diagnosticParams(RPCParameters* p){
    auto b=stream(p);uint16_t id;uint8_t engine,lights,alarm,doors;
    if(!b.Read(id)||!id||id>=diagnosticCars.size()||!diagnosticCars[id].present||!b.Read(engine)||!b.Read(lights)||!b.Read(alarm)||!b.Read(doors))return;
    auto& c=diagnosticCars[id];c.engineKnown=engine<=1;c.engine=engine==1;c.locked=doors==1;
}
void diagnosticHealth(RPCParameters* p){
    auto b=stream(p);uint16_t id;float hp;if(!b.Read(id)||!id||id>=diagnosticCars.size()||!b.Read(hp)||!std::isfinite(hp)||hp<0||hp>2000)return;
    if(diagnosticCars[id].present)diagnosticCars[id].hp=hp;
}
void diagnosticRegister(){
    registerObservedRPC(RPC_SetCheckpoint,diagnosticCheckpointSet);
    registerObservedRPC(RPC_DisableCheckpoint,diagnosticCheckpointOff);
    registerObservedRPC(RPC_WorldVehicleAdd,diagnosticAdd);
    registerObservedRPC(RPC_WorldVehicleRemove,diagnosticRemove);
    registerObservedRPC(RPC_ScrSetVehiclePos,diagnosticPos);
    registerObservedRPC(RPC_ScrPutPlayerInVehicle,diagnosticPut);
    registerObservedRPC(RPC_ScrRemovePlayerFromVehicle,diagnosticEject);
    registerObservedRPC(diagnosticParamsRPC,diagnosticParams);
    registerObservedRPC(RPC_ScrSetVehicleHealth,diagnosticHealth);
}
bool diagnosticBoard(int id){
    if(state!=3||!spawned||clientPaused||dialogId>=0||selectingTextdraws||diagnosticVehicle||diagnosticLocalVehicle||diagnosticRequested||id<=0||id>=int(diagnosticCars.size()))return false;
    const auto& c=diagnosticCars[id];if(!c.present||c.model!=560||c.locked)return false;
    float d2=0;for(int i=0;i<3;i++)d2+=(position[i]-c.pos[i])*(position[i]-c.pos[i]);if(d2>36)return false;
    RakNet::BitStream b;b.Write(uint16_t(id));b.Write(uint8_t(0));rpc(RPC_EnterVehicle,b);
    diagnosticRequested=id;diagnosticEntrySyncs=0;diagnosticEntryState="request-sent";diagnosticEntryReason.clear();diagnosticBoardAt=std::chrono::steady_clock::now();return true;
}
bool diagnosticSync(){
    if(diagnosticRequested&&std::chrono::steady_clock::now()-diagnosticBoardAt>=std::chrono::milliseconds(1200)){
        const auto& c=diagnosticCars[diagnosticRequested];float d2=0;
        for(int i=0;i<3;i++)d2+=(position[i]-c.pos[i])*(position[i]-c.pos[i]);
        if(!c.present||c.locked||c.model!=560||d2>36||dialogId>=0||selectingTextdraws){diagnosticClearEntry("entry-preconditions-changed");return false;}
        diagnosticLocalVehicle=diagnosticRequested;diagnosticRequested=0;
        diagnosticEntryState="normal-sync-sent";
        // Enter the received car in place. The car never moves and no driving
        // input is generated. A client report is not labelled a server ACK.
        std::copy(c.pos,c.pos+3,position);angleQuat(c.angle,rotation);
    }
    const uint16_t active=diagnosticVehicle?diagnosticVehicle:diagnosticLocalVehicle;
    if(!active)return false;
    if(diagnosticVehicle&&diagnosticSeat!=0)return true; // Never emit on-foot sync from a server-assigned passenger seat.
    const auto& c=diagnosticCars[active];if(!c.present)return true;
    float velocity[3]{};shortDriveStep(velocity);
    RakNet::BitStream b;b.Write(uint8_t(ID_VEHICLE_SYNC));b.Write(active);
    for(int i=0;i<3;i++)b.Write(uint16_t(0));
    for(float f:rotation)b.Write(f);for(float f:position)b.Write(f);for(float f:velocity)b.Write(f);
    b.Write(c.hp);b.Write(uint8_t(health));b.Write(uint8_t(armour));
    for(int i=0;i<3;i++)b.Write(uint8_t(0));b.Write(uint16_t(0));b.Write(0.f);
    client->Send(&b,HIGH_PRIORITY,UNRELIABLE_SEQUENCED,0);++diagnosticEntrySyncs;return true;
}
std::string diagnosticStatusJson(){
    std::string out="{\"type\":\"vehicleDiagnostic\",\"revision\":"+std::to_string(diagnosticRevision)+",\"vehicle\":"+std::to_string(diagnosticVehicle)+",\"seat\":"+std::to_string(diagnosticSeat)+",\"requested\":"+std::to_string(diagnosticRequested)+",\"drivingAvailable\":false,\"position\":[";
    for(int i=0;i<3;i++){if(i)out+=',';out+=std::to_string(position[i]);}out+="],\"clientVehicle\":"+std::to_string(diagnosticLocalVehicle)+",\"entryState\":"+quote(diagnosticEntryState)+",\"entryReason\":"+quote(diagnosticEntryReason)+",\"entrySyncPackets\":"+std::to_string(diagnosticEntrySyncs)+",\"vehicleAdds\":"+std::to_string(diagnosticAdds)+",\"rejectedAdds\":"+std::to_string(diagnosticRejected)+",\"lastRejectedReason\":"+quote(diagnosticRejectReason)+",\"nearbyVehicles\":[";
    std::vector<std::pair<float,int>> all,near;
    for(int id=1;id<int(diagnosticCars.size());id++)if(diagnosticCars[id].present){
        float d2=0;for(int i=0;i<3;i++)d2+=(position[i]-diagnosticCars[id].pos[i])*(position[i]-diagnosticCars[id].pos[i]);all.push_back({d2,id});
        if(diagnosticCars[id].model==560)near.push_back({d2,id});
    }
    std::sort(all.begin(),all.end());
    for(size_t n=0;n<all.size()&&n<12;n++){
        if(n)out+=',';const auto& c=diagnosticCars[all[n].second];
        out+="{\"id\":"+std::to_string(all[n].second)+",\"model\":"+std::to_string(c.model)+",\"distance\":"+std::to_string(std::sqrt(all[n].first))+"}";
    }
    out+="],\"sultans\":[";
    std::sort(near.begin(),near.end());
    for(size_t n=0;n<near.size()&&n<20;n++){
        if(n)out+=',';const auto& c=diagnosticCars[near[n].second];
        out+="{\"id\":"+std::to_string(near[n].second)+",\"revision\":"+std::to_string(c.revision)+",\"distance\":"+std::to_string(std::sqrt(near[n].first))+",\"angle\":"+std::to_string(c.angle)+",\"position\":["+std::to_string(c.pos[0])+","+std::to_string(c.pos[1])+","+std::to_string(c.pos[2])+"],\"horizontalDistance\":"+std::to_string(std::hypot(c.pos[0]-position[0],c.pos[1]-position[1]))+",\"heightDifference\":"+std::to_string(c.pos[2]-position[2])+",\"engineKnown\":"+(c.engineKnown?"true":"false")+",\"engine\":"+(c.engine?"true":"false")+",\"locked\":"+(c.locked?"true":"false")+",\"health\":"+std::to_string(c.hp)+"}";
    }
    return out+"],\"checkpoint\":"+diagnosticCheckpointJson()+",\"shortTrial\":"+shortDriveJson()+"}";
}
void diagnosticStatus(){emit(diagnosticStatusJson());}
#include "short-drive.hpp"
