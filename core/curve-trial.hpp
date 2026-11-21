// GPL-2.0-or-later. Short circular-arc trial, not GTA steering physics.
#pragma once
#include "ground-support.hpp"
#include <string>

namespace KLRM { namespace Obstacle {
class CurveTrial {
    struct Piece {std::unique_ptr<Mesh> mesh;Vec from,to;Body envelope;double end;};
    std::vector<Piece> pieces;
    std::optional<StopPlan> plan;
    Vec forward,right,groundGradient;
    Box coverage;
    double clock=0;
public:
    static constexpr double length=2,turn=3.141592653589793/12,radius=length/turn,speedLimit=.65;
    Vec origin;
    double initialAngle=0,clearance=0;
    int side=1;
    unsigned supportTriangles=0;
    State state;
    bool ready=false,active=false,finished=false;
    std::string reason="idle";
    Vec point(double distance)const{
        double theta=distance/radius;Vec delta=forward*(radius*std::sin(theta))+right*(side*radius*(1-std::cos(theta)));
        delta.z=dot(groundGradient,delta);return origin+delta;
    }
    Vec tangent(double distance)const{
        double theta=distance/radius;Vec v=forward*std::cos(theta)+right*(side*std::sin(theta));v.z=dot(groundGradient,v);return v;
    }
    double heading(double distance)const{
        double a=std::fmod(initialAngle-side*distance/radius*180/3.141592653589793,360.);return a<0?a+360:a;
    }
    bool clearRemaining(double progress=0)const{
        if(!ready)return false;
        for(const auto& p:pieces)if(p.end+1e-9>=progress){
            World world;world.mesh=p.mesh.get();world.coverage=coverage;world.staticComplete=world.dynamicsComplete=true;
            auto delta=p.to-p.from;auto sensed=world.sense(p.from,unit(delta),norm(delta),p.envelope,0);
            if(sensed.quality!=Quality::Known||sensed.hit)return false;
        }return true;
    }
    void prepare(const std::vector<Triangle>& triangles,const std::vector<Sphere>& spheres,const std::vector<SolidBox>& boxes,
                 Box area,Vec start,double angle,int turnSide){
        if(!finite(start)||!std::isfinite(angle)||std::abs(angle)>36000||(turnSide!=1&&turnSide!=-1)||!valid(area))throw std::runtime_error("invalid-curve-query");
        *this=CurveTrial{};origin=start;initialAngle=angle;side=turnSide;coverage=area;
        const double radians=angle*3.141592653589793/180.;forward={-std::sin(radians),std::cos(radians),0};right={forward.y,-forward.x,0};
        Vec first=point(.1)-origin;first.z=0;GroundSupport initial;
        initial.prepare(triangles,spheres,boxes,coverage,origin,unit(first),norm(first),Body{});
        groundGradient=initial.gradient();clearance=initial.clearance;
        const int count=int(std::ceil((length+.6)/.1));
        for(int i=0;i<count;i++){
            double a=(length+.6)*i/count,b=(length+.6)*(i+1)/count;
            Vec p=point(a),q=point(b),flat=q-p;flat.z=0;
            if(std::abs(p.z-origin.z)>.15||std::abs(q.z-origin.z)>.15)throw std::runtime_error("ground-not-level");
            const double rotation=b/radius-a/radius,bodyRadius=std::hypot(2.4,1.);
            // Enclose rotation about the mid-yaw and the arc/chord sagitta.
            // The fixed-orientation sweep then contains the complete rotating
            // box, including a pole between sampled centre-line points.
            double inflation=2*bodyRadius*std::sin(rotation/4)+radius*(1-std::cos(rotation/2))*std::sqrt(1+dot(groundGradient,groundGradient))+1e-4;
            Body envelope;envelope.half=envelope.half+Vec{inflation,inflation,inflation};
            Vec mid=tangent((a+b)/2);mid.z=0;mid=unit(mid);envelope.axes={mid,Vec{-mid.y,mid.x,0},Vec{0,0,1}};
            GroundSupport support;support.prepare(triangles,spheres,boxes,coverage,p,unit(flat),norm(flat),envelope);
            if(std::abs(support.clearance-clearance)>.03||std::abs(support.target.z-q.z)>.03)throw std::runtime_error("ground-not-level");
            supportTriangles+=support.supportTriangles;
            pieces.push_back({std::move(support.obstacles),p,q,envelope,b});
        }
        ready=true;
        if(!clearRemaining()){ready=false;throw std::runtime_error("mapped-obstacle-in-segment");}
        reason="manual-start-required";
    }
    bool start(){
        if(!ready||active||finished||state.position>1e-9||!clearRemaining())return false;
        Limits limits;limits.speed=speedLimit/std::sqrt(1+dot(groundGradient,groundGradient));
        plan=planStop({},length,limits);if(!plan)return false;
        clock=0;state={};active=true;finished=false;reason="short-manual-curve";return true;
    }
    void stop(const char* why){active=false;state.speed=state.acceleration=state.jerk=0;reason=why;}
    void step(double dt){
        if(!active)return;
        if(!std::isfinite(dt)||dt<0||dt>.25){stop("controller-gap");return;}
        if(!clearRemaining(state.position)){stop("mapped-obstacle-in-segment");return;}
        clock+=dt;state=plan->at(clock);
        if(clock>=plan->duration){active=false;finished=true;reason="destination";}
    }
};
}} // namespace KLRM::Obstacle
