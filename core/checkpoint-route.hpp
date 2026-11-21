// GPL-2.0-or-later. Playback of a CADB-checked route to one live checkpoint.
#pragma once
#include "route-map.hpp"
#include <fstream>
namespace KLRM { namespace Obstacle {
class CheckpointRoute {
    double clock=0;struct Section{double start,end,peak,ramp,cruise,time,duration;bool reverse;};std::vector<Section> sections;
public:
    std::vector<RoutePose> poses;State state;Vec goal;double radius=0;unsigned long revision=0;
    bool prepared=false,active=false,finished=false;std::string reason="idle";
    static constexpr double speedLimit=4;
    void load(const std::string& file){
        *this=CheckpointRoute{};std::ifstream in(file,std::ios::ate);if(!in||in.tellg()>32*1024*1024)throw std::runtime_error("invalid-route-file");in.seekg(0);
        std::string magic;std::size_t count;
        if(!(in>>magic>>revision>>goal.x>>goal.y>>goal.z>>radius>>count)||magic!="RMR1"||!finite(goal)||radius<.5||radius>20||count<2||count>180000)throw std::runtime_error("invalid-route-header");
        poses.reserve(count);
        for(std::size_t i=0;i<count;i++){
            RoutePose p;if(!(in>>p.distance>>p.p.x>>p.p.y>>p.p.z>>p.forward.x>>p.forward.y>>p.forward.z>>p.up.x>>p.up.y>>p.up.z)||!finite(p.p)||!finite(p.forward)||!finite(p.up)||!std::isfinite(p.distance)||std::abs(norm(p.forward)-1)>.001||std::abs(norm(p.up)-1)>.001||std::abs(dot(p.forward,p.up))>.001||p.up.z<.93||norm(p.p)>15000)throw std::runtime_error("invalid-route-pose");
            if(i){const auto& a=poses.back();double delta=p.distance-a.distance;if(delta<=0||delta>.65||std::abs(norm(p.p-a.p)-delta)>.002||dot(p.forward,a.forward)<.995)throw std::runtime_error("invalid-route-step");}
            else if(p.distance!=0)throw std::runtime_error("invalid-route-origin");
            poses.push_back(p);
        }
        in>>std::ws;if(!in.eof()||poses.back().distance>40000||norm(poses.back().p-goal)>std::max(.25,radius-.5))throw std::runtime_error("invalid-route-destination");
        prepared=true;buildTiming();reason="manual-start-required";
    }
    double length()const{return poses.empty()?0:poses.back().distance;}
    RoutePose at(double distance)const{
        if(poses.empty())return {};
        auto next=std::upper_bound(poses.begin(),poses.end(),distance,[](double d,const RoutePose& p){return d<p.distance;});
        if(next==poses.begin())return *next;if(next==poses.end())return poses.back();
        auto a=next-1;double t=(distance-a->distance)/(next->distance-a->distance);RoutePose out;
        out.p=a->p+(next->p-a->p)*t;out.up=unit(a->up+(next->up-a->up)*t);
        auto f=a->forward+(next->forward-a->forward)*t;out.forward=unit(f-out.up*dot(f,out.up));out.distance=distance;return out;
    }
    bool start(){
        if(!prepared||active||finished||state.position!=0)return false;
        buildTiming();if(sections.empty())return false;active=true;reason="checkpoint-route";clock=0;return true;
    }
    void buildTiming(){
        sections.clear();double from=0,time=0,limit=speedLimit;int priorGear=0;
        for(std::size_t i=1;i<poses.size();i++){
            int gear=dot(poses[i].p-poses[i-1].p,poses[i-1].forward)>=0?1:-1;
            if(priorGear&&gear!=priorGear){addSection(from,poses[i-1].distance,priorGear<0,time,limit);from=poses[i-1].distance;limit=speedLimit;}
            Vec a=unit(Vec{poses[i-1].forward.x,poses[i-1].forward.y,0}),b=unit(Vec{poses[i].forward.x,poses[i].forward.y,0});
            double turn=std::acos(std::clamp(dot(a,b),-1.,1.))/std::max(.001,poses[i].distance-poses[i-1].distance);
            // Tight final-access turns use at most 2 m/s. Finish the current
            // section at rest before reducing its limit; retain that limit
            // through the manoeuvre instead of toggling at every sample.
            if(gear>0&&turn>.14&&limit>2){addSection(from,poses[i-1].distance,false,time,limit);from=poses[i-1].distance;limit=2;}
            priorGear=gear;
        }
        addSection(from,length(),priorGear<0,time,limit);
    }
    void addSection(double from,double end,bool reverse,double& time,double limit){
        double distance=end-from;if(distance<=1e-6)return;double ramp=4,peak=std::min(reverse?1.:limit,distance/ramp),cruise=std::max(0.,distance/peak-ramp),duration=2*ramp+cruise;
        sections.push_back({from,end,peak,ramp,cruise,time,duration,reverse});time+=duration;
    }
    double duration()const{return sections.empty()?0:sections.back().time+sections.back().duration;}

    void stop(const char* why){active=false;state.speed=state.acceleration=state.jerk=0;reason=why;}
    void step(double dt){
        if(!active)return;if(!std::isfinite(dt)||dt<0||dt>.25){stop("controller-gap");return;}clock+=dt;
        if(clock>=duration()){state={length(),0,0,0};active=false;finished=true;reason="checkpoint-position-reached";return;}
        const Section* section=&sections.back();for(const auto& s:sections)if(clock<s.time+s.duration){section=&s;break;}
        const auto& s=*section;double local=clock-s.time,ramp=s.ramp,peak=s.peak,cruise=s.cruise;
        auto integral=[](double u){return u*u*u-.5*u*u*u*u;};
        if(local<ramp){double u=local/ramp;state={s.start+peak*ramp*integral(u),peak*(3*u*u-2*u*u*u),peak/ramp*6*u*(1-u),peak/(ramp*ramp)*6*(1-2*u)};}
        else if(local<ramp+cruise)state={s.start+peak*ramp*.5+peak*(local-ramp),peak,0,0};
        else {double u=(local-ramp-cruise)/ramp;state={s.start+peak*ramp*.5+peak*cruise+peak*ramp*(u-integral(u)),peak*(1-3*u*u+2*u*u*u),-peak/ramp*6*u*(1-u),-peak/(ramp*ramp)*6*(1-2*u)};}

    }

};
}} // namespace
