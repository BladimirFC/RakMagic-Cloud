// GPL-2.0-or-later. Experimental protocol adapter and collision-aware trajectory.
#pragma once
#include "raycast-lab.hpp"
#include "collision-assets.hpp"
#include "BitStream.h"
#include "PacketEnumerations.h"
#include <cstdint>
#include <memory>
#include <string>

namespace KLRM { namespace Obstacle {
struct VehicleFrame { uint16_t player=0,vehicle=0;Vec position,velocity; };
inline bool readVec(RakNet::BitStream& b,Vec& v){
    float x,y,z;if(!b.Read(x)||!b.Read(y)||!b.Read(z))return false;
    v={x,y,z};return finite(v);
}
// Server -> client layout differs from the client's raw driver packet. Check
// every bit before publishing a complete frame; do not call unchecked legacy
// ReadNormQuat/ReadVector helpers on network input.
inline bool decodeVehicle(const unsigned char* data,std::size_t bytes,unsigned bits,VehicleFrame& out){
    if(!data||bytes==0||bytes>256||bits>bytes*8||bits+7<bytes*8)return false;
    RakNet::BitStream b(const_cast<unsigned char*>(data),static_cast<int>(bytes),false);b.SetWriteOffset(bits);
    uint8_t type;if(!b.Read(type))return false;
    if(type==ID_TIMESTAMP){uint32_t stamp;if(!b.Read(stamp)||!b.Read(type))return false;}
    if(type!=ID_VEHICLE_SYNC&&type!=ID_UNOCCUPIED_SYNC)return false;
    VehicleFrame v;
    if(!b.Read(v.player)||v.player>=1004||!b.Read(v.vehicle)||!v.vehicle||v.vehicle>=2000)return false;
    if(type==ID_VEHICLE_SYNC){
        uint16_t axis,keys;for(int i=0;i<2;i++)if(!b.Read(axis))return false;if(!b.Read(keys))return false;
        bool sign[4];for(bool& s:sign)if(!b.Read(s))return false;
        double square=0;for(int i=0;i<3;i++){uint16_t q;if(!b.Read(q))return false;double c=q/65535.;square+=c*c;}
        if(square>1.0002||!readVec(b,v.position))return false;
        float magnitude;if(!b.Read(magnitude)||!std::isfinite(magnitude)||magnitude<0||magnitude>2)return false;
        if(magnitude>0){float c[3];for(float& x:c)if(!b.ReadCompressed(x))return false;v.velocity={c[0]*magnitude*50,c[1]*magnitude*50,c[2]*magnitude*50};}
        uint16_t hp;uint8_t pair,weapon;bool flag;
        if(!b.Read(hp)||hp>2000||!b.Read(pair)||!b.Read(weapon)||!b.Read(flag)||!b.Read(flag)||!b.Read(flag))return false;
        uint32_t thrust;if(flag&&!b.Read(thrust))return false;
        if(!b.Read(flag))return false;uint16_t trailer;if(flag&&(!b.Read(trailer)||trailer>=2000))return false;
    }else{
        uint8_t seat;Vec roll,direction,angular;float hp;
        if(!b.Read(seat)||seat>7||!readVec(b,roll)||!readVec(b,direction)||!readVec(b,v.position)||!readVec(b,v.velocity)||!readVec(b,angular)||!b.Read(hp)||!std::isfinite(hp)||hp<0||hp>2000)return false;
        v.velocity=v.velocity*50;
        if(norm(roll)<.5||norm(roll)>1.5||norm(direction)<.5||norm(direction)>1.5)return false;
    }
    if(!finite(v.position)||std::abs(v.position.x)>10000||std::abs(v.position.y)>10000||std::abs(v.position.z)>10000||!finite(v.velocity)||norm(v.velocity)>100)return false;
    // Only byte padding may remain. Unexpected tails indicate a wrong format.
    if(b.GetNumberOfUnreadBits()>7)return false;
    out=v;return true;
}
inline void appendBox(std::vector<Triangle>& triangles,Box box,int id){
    if(!valid(box)||box.lo.x>=box.hi.x||box.lo.y>=box.hi.y||box.lo.z>=box.hi.z)throw std::invalid_argument("invalid box");
    Vec p[8];for(int i=0;i<8;i++)p[i]={i&1?box.hi.x:box.lo.x,i&2?box.hi.y:box.lo.y,i&4?box.hi.z:box.lo.z};
    constexpr int faces[12][3]={{0,1,3},{0,3,2},{4,6,7},{4,7,5},{0,4,5},{0,5,1},{2,3,7},{2,7,6},{0,2,6},{0,6,4},{1,5,7},{1,7,3}};
    for(auto& f:faces)triangles.push_back({p[f[0]],p[f[1]],p[f[2]],id});
}
struct Scene {
    std::unique_ptr<Mesh> mesh;Box coverage;uint8_t interior=0;
    std::array<std::optional<Vec>,212> half{};
};
struct Peer { bool present=false,received=false;int model=0;Vec position,velocity;double stamp=0;bool located=false; };
class Sensor {
public:
    std::array<Peer,2000> peers{};uint64_t accepted=0,rejected=0;
    void reset(){peers={};accepted=rejected=0;}
    void add(int id,int model){if(id>0&&id<2000)peers[id]=Peer{true,false,model,{},{},0};}
    void remove(int id){if(id>0&&id<2000)peers[id]={};}
    bool receive(const unsigned char* data,std::size_t bytes,unsigned bits,double now){
        VehicleFrame f;if(!decodeVehicle(data,bytes,bits,f)){rejected++;return false;}
        auto& peer=peers[f.vehicle];if(!peer.present){rejected++;return false;}
        peer.received=peer.located=true;peer.position=f.position;peer.velocity=f.velocity;peer.stamp=now;accepted++;return true;
    }
    // A validated server position bounds location, never proves zero velocity.
    void locate(int id,Vec position,double now){
        if(id>0&&id<2000&&peers[id].present&&finite(position)&&std::isfinite(now)){
            auto& peer=peers[id];peer.position=position;peer.stamp=now;peer.located=true;peer.received=false;
        }
    }
    // A position-only RPC cannot prove the velocity of an unoccupied car.
    void invalidate(int id){if(id>0&&id<2000)peers[id].received=false;}
    SensorResult sense(const Scene& scene,int own,int interior,Vec position,Vec direction,double range,Body body,double now,double unknownHorizon=-1)const{
        if(!scene.mesh)return {Quality::Unknown,{},"missing-world"};
        if(interior<0||interior!=scene.interior)return {Quality::Unknown,{},"wrong-interior"};
        if(!finite(position)||!finite(direction)||std::abs(norm(direction)-1)>1e-6||!valid(body)||!std::isfinite(range)||range<0||!std::isfinite(now)||!std::isfinite(unknownHorizon)||unknownHorizon>10||(unknownHorizon>=0&&unknownHorizon<.5))return {Quality::Unknown,{},"invalid-query"};
        World world;world.mesh=scene.mesh.get();world.coverage=scene.coverage;world.staticComplete=world.dynamicsComplete=true;
        unsigned excluded=0;
        for(int id=1;id<2000;id++){
            const auto& p=peers[id];if(id==own||!p.present)continue;
            const bool sized=p.model>=400&&p.model<=611&&bool(scene.half[p.model-400]);
            // Exclude uncertain motion only if a 100 m/s reachable envelope
            // cannot touch this complete swept corridor before a controlled
            // stop. Old positions expand the envelope; unknown location/size
            // is never treated as distant. The strict lab path stays default.
            const bool stale=!p.received||now-p.stamp>world.maximumAge||p.stamp>now+.001;
            if(unknownHorizon>=0&&stale&&sized&&(p.located||p.received)&&finite(p.position)&&std::isfinite(p.stamp)&&p.stamp<=now+.001){
                const double radius=norm(*scene.half[p.model-400])+100*(std::max(0.,now-p.stamp)+unknownHorizon);
                const Vec h{radius,radius,radius};
                if(!rayBox(position,direction,range,expand({p.position-h,p.position+h},worldHalf(body)))){excluded++;continue;}
            }
            if(!p.received)return {Quality::Unknown,{},"missing-vehicle-data",id,excluded};
            if(!sized)return {Quality::Unknown,{},"unknown-vehicle-size",id,excluded};
            // Rotating peers use a conservative sphere-enclosing AABB. The
            // wire rotation is validated, but a future turn is not predicted.
            double r=norm(*scene.half[p.model-400]);Vec h{r,r,r};
            world.vehicles.push_back({{p.position-h,p.position+h},p.velocity,p.stamp,id});
        }
        auto result=world.sense(position,direction,range,body,now);result.excluded=excluded;return result;
    }
};
class Navigator {
    std::optional<StopPlan> plan;double clock=0,planAt=0,lastClearEnd=0,stoppedAt=-1;
    bool staleLatched=false;
public:
    State state;Vec origin,direction;double goal=0;Limits limits;Body body;
    bool active=false,finished=false,blocked=false,emergency=false,resumed=false;
    std::string reason="idle";int hitId=-1;uint64_t replans=0;
    bool begin(Vec start,Vec target,double speed,Vec half){
        *this=Navigator{};origin=start;Vec delta=target-start;goal=norm(delta);
        if(!finite(start)||!finite(target)||goal<.1||goal>44||!std::isfinite(speed)||speed<.5||speed>8)return false;
        if(std::hypot(delta.x,delta.y)<.1)return false;
        direction=unit(delta);limits.speed=speed;body.half=half;
        // Match the yaw-only quaternion emitted by this kinematic client.
        // The sweep may translate along a slope; pitch/roll physics is absent.
        const Vec forward=unit(Vec{direction.x,direction.y,0});
        const Vec side=Vec{-forward.y,forward.x,0};body.axes={forward,side,Vec{0,0,1}};
        if(!valid(body))return false;active=true;reason="awaiting-world";return true;
    }
    double timeSeconds()const{return clock;}
    Vec position()const{return origin+direction*state.position;}
    void step(double dt,const SensorResult& sensed){
        if(!active)return;
        if(!std::isfinite(dt)||dt<0||dt>.25){active=false;emergency=true;reason="controller-gap";return;}
        const double nextClock=clock+dt;
        double target=goal;
        if(sensed.quality==Quality::Unknown){
            reason=sensed.reason;staleLatched=true;
            if(!plan&&state.speed<1e-7){active=false;blocked=true;return;}
            // Find a feasible progressive stop inside the last checked corridor.
            if(!blocked){
                std::optional<StopPlan> stop;
                double end=std::min(lastClearEnd,plan?plan->target:goal);
                for(double d=.05;state.position+d<=end+1e-6;d+=.20){stop=planStop(state,state.position+d,limits);if(stop)break;}
                if(!stop){active=false;emergency=true;reason="unknown-world-stop-infeasible";return;}
                plan=std::move(stop);planAt=clock;replans++;blocked=true;
            }
            target=plan->target;
        }else if(!staleLatched){
            hitId=sensed.hit?sensed.hit->id:-1;
            if(sensed.hit)target=std::min(goal,state.position+sensed.hit->distance-.6);
            lastClearEnd=target;reason=sensed.hit?"obstacle":"clear";
        }else target=plan?plan->target:state.position;
        bool done=plan&&clock-planAt>=plan->duration;
        bool need=!plan||(target<plan->target-.02);
        if(done){
            // Sample exact end before deciding whether to resume.
            state=plan->at(plan->duration);
            if(staleLatched){active=false;blocked=true;return;}
            if(std::abs(state.position-goal)<.001){active=false;finished=true;reason="destination";return;}
            if(stoppedAt<0)stoppedAt=clock;
            blocked=true;
            if(target>state.position+.05&&clock-stoppedAt>=.5){need=true;resumed=true;blocked=false;}
        }
        if(need){
            if(target<=state.position+.001&&state.speed<1e-7){blocked=true;clock=nextClock;return;}
            auto next=planStop(state,target,limits);
            if(!next){active=false;emergency=true;reason="braking-infeasible";return;}
            plan=std::move(next);planAt=clock;stoppedAt=-1;replans++;
        }
        clock=nextClock;
        if(plan)state=plan->at(clock-planAt);
    }
};
}} // namespace KLRM::Obstacle
