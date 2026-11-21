// GPL-2.0-or-later. Bounded planar ground support for short kinematic trials.
#pragma once
#include "raycast-lab.hpp"
#include <memory>

namespace KLRM { namespace Obstacle {
class GroundSupport {
    Vec point,normal;
    double planeHeight(Vec p)const{return point.z-(normal.x*(p.x-point.x)+normal.y*(p.y-point.y))/normal.z;}
public:
    Vec gradient()const{if(!ready)throw std::runtime_error("missing-ground");return {-normal.x/normal.z,-normal.y/normal.z,0};}
    Vec target;
    double clearance=0,rise=0,grade=0;
    unsigned supportTriangles=0;
    bool ready=false;
    std::unique_ptr<Mesh> obstacles;
    void prepare(const std::vector<Triangle>& triangles,const std::vector<Sphere>& spheres,const std::vector<SolidBox>& boxes,
                 Box coverage,Vec start,Vec forward,double metres,Body body){
        *this=GroundSupport{};
        if(!finite(start)||!finite(forward)||std::abs(norm(forward)-1)>1e-6||std::abs(forward.z)>1e-6||!valid(body)||!valid(coverage)||!std::isfinite(metres)||metres<.05||metres>5)throw std::runtime_error("invalid-ground-query");
        Mesh original(triangles,spheres,boxes);
        // Identify the actual support face. A wall, solid box, sphere or a
        // different storey must not become ground just because it was hit.
        auto surface=[&](Vec p)->std::pair<double,std::size_t>{
            Vec from=p+Vec{0,0,.1};auto hit=original.cast(from,{0,0,-1},3);
            if(!hit)throw std::runtime_error("missing-ground");
            if(hit->distance<.3)throw std::runtime_error("mapped-obstacle-in-segment");
            for(std::size_t i=0;i<triangles.size();i++){
                auto distance=rayTriangle(from,{0,0,-1},3,triangles[i]);
                if(distance&&std::abs(*distance-hit->distance)<1e-6){
                    auto n=unit(cross(triangles[i].b-triangles[i].a,triangles[i].c-triangles[i].a));
                    if(std::abs(n.z)<.989)throw std::runtime_error("ground-not-level");
                    return {from.z-*distance,i};
                }
            }
            throw std::runtime_error("mapped-obstacle-in-segment");
        };
        auto initial=surface(start);point=triangles[initial.second].a;
        normal=unit(cross(triangles[initial.second].b-point,triangles[initial.second].c-point));
        clearance=start.z-initial.first;
        if(clearance<.2||clearance>1.5)throw std::runtime_error("unsupported-ground-clearance");
        grade=-(normal.x*forward.x+normal.y*forward.y)/normal.z;
        rise=grade*metres;
        // Keep the existing small-height-change bound, including stopping
        // clearance. This is a short planar test, not general terrain driving.
        if(std::abs(grade)>.15||std::abs(grade)*(metres+.6)>.15)throw std::runtime_error("ground-not-level");
        target=start+forward*metres;target.z+=rise;
        Vec direction=unit(target-start);Body sweep=body;sweep.axes={forward,Vec{-forward.y,forward.x,0},Vec{0,0,1}};
        const double range=norm(target-start)+.6;Vec half=worldHalf(sweep);
        if(!contains(coverage,merge({start-half,start+half},{start+direction*range-half,start+direction*range+half})))throw std::runtime_error("unmapped-corridor");
        // Check centre and side tracks every <= 25 cm. Small road-face joins
        // may differ by 3 cm; larger steps, gaps and layer changes fail.
        const double front=metres+.6;
        const int count=int(std::ceil(front/.25));
        for(int k=0;k<=count;k++)for(double side:{-body.half.y,0.,body.half.y}){
            double along=front*k/count;
            Vec p=start+forward*along+Vec{-forward.y,forward.x,0}*side;
            p.z=start.z+planeHeight(p)-initial.first;
            auto sampled=surface(p);
            if(std::abs(sampled.first-planeHeight(p))>.03)throw std::runtime_error("ground-not-level");
        }
        const Vec sideAxis{-forward.y,forward.x,0};
        // Clip faces to the actual swept footprint before classifying them.
        // A long road triangle can deviate far outside the tested segment.
        auto clip=[](std::vector<Vec> polygon,int axis,double edge,bool minimum){
            std::vector<Vec> output;if(polygon.empty())return output;
            Vec previous=polygon.back();bool wasInside=minimum?previous[axis]>=edge:previous[axis]<=edge;
            for(auto current:polygon){bool inside=minimum?current[axis]>=edge:current[axis]<=edge;
                if(inside!=wasInside){double fraction=(edge-previous[axis])/(current[axis]-previous[axis]);output.push_back(previous+(current-previous)*fraction);}
                if(inside)output.push_back(current);previous=current;wasInside=inside;
            }return output;
        };
        std::vector<Triangle> blocking;blocking.reserve(triangles.size());
        for(auto t:triangles){
            Vec n=unit(cross(t.b-t.a,t.c-t.a));
            bool support=std::abs(n.z)>=.989;
            if(support){
                std::vector<Vec> polygon;
                for(auto vertex:{t.a,t.b,t.c}){auto delta=vertex-start;polygon.push_back({dot(delta,forward),dot(delta,sideAxis),vertex.z});}
                polygon=clip(std::move(polygon),0,-body.half.x,true);polygon=clip(std::move(polygon),0,front+body.half.x,false);
                polygon=clip(std::move(polygon),1,-body.half.y,true);polygon=clip(std::move(polygon),1,body.half.y,false);
                support=!polygon.empty();
                for(auto vertex:polygon){auto world=start+forward*vertex.x+sideAxis*vertex.y;support=support&&std::abs(vertex.z-planeHeight(world))<=.03;}
            }
            if(support)supportTriangles++;else blocking.push_back(t);
        }
        // Only locally matching support triangles are separated. All solids,
        // vertical faces, ceilings and raised surfaces retain their collisions.
        obstacles=std::make_unique<Mesh>(std::move(blocking),spheres,boxes);ready=true;
    }
};
}} // namespace KLRM::Obstacle
