// GPL-2.0-or-later. Spatially indexed CADB queries for the offline route planner.
#pragma once
#include "collision-assets.hpp"
#include <map>
#include <list>
#include <string>
namespace KLRM { namespace Obstacle {
// Standard single-player island barriers, absent from the SA-MP base map.
// Reference: ColAndreas CA_RemoveBarriers, commit afe3da7e6ba170777fdb021f8b8d5b7e20752523.
inline bool singlePlayerBarrier(int model){return (model>=4504&&model<=4527)||(model>=16436&&model<=16439)||model==1662;}
constexpr double routePi=3.141592653589793;
struct RoutePose { Vec p,forward,up{0,0,1};double yaw=0,distance=0; };
class RouteMap {
    Assets::Library library;
    std::map<std::pair<int,int>,std::vector<std::size_t>> grid;
    struct Tile {std::unique_ptr<Mesh> mesh;unsigned long used;};
    std::map<std::pair<int,int>,Tile> cache;
    unsigned long clock=0;
    static constexpr double size=32;
    Mesh& tile(Vec p){
        auto key=std::make_pair(int(std::floor(p.x/size)),int(std::floor(p.y/size)));
        auto found=cache.find(key);if(found!=cache.end()){found->second.used=++clock;return *found->second.mesh;}
        if(cache.size()>=24){auto old=std::min_element(cache.begin(),cache.end(),[](const auto& a,const auto& b){return a.second.used<b.second.used;});cache.erase(old);}
        Box area{{key.first*size-6,key.second*size-6,-150},{(key.first+1)*size+6,(key.second+1)*size+6,1500}};
        auto& ids=grid[key];if(ids.empty())throw std::runtime_error("missing-ground");
        auto g=library.bake(area,&ids);
        // CADB bridge decks can be oriented boxes rather than triangles.
        // Tessellate all six faces so the top is sampled as support while
        // side faces retain collision. No box is simply discarded as ground.
        constexpr int faces[12][3]={{0,1,3},{0,3,2},{4,6,7},{4,7,5},{0,4,5},{0,5,1},{2,3,7},{2,7,6},{0,2,6},{0,6,4},{1,5,7},{1,7,3}};
        for(const auto& box:g.boxes){Vec vertices[8];for(int i=0;i<8;i++)vertices[i]=box.centre+box.body.axes[0]*(i&1?box.body.half.x:-box.body.half.x)+box.body.axes[1]*(i&2?box.body.half.y:-box.body.half.y)+box.body.axes[2]*(i&4?box.body.half.z:-box.body.half.z);
            for(const auto& face:faces)g.triangles.push_back({vertices[face[0]],vertices[face[1]],vertices[face[2]],box.id});}
        g.boxes.clear();
        auto mesh=std::make_unique<Mesh>(std::move(g.triangles),std::move(g.spheres),std::move(g.boxes));
        return *cache.emplace(key,Tile{std::move(mesh),++clock}).first->second.mesh;
    }
public:
    double clearance=.75;unsigned queries=0;std::string lastReason;
    explicit RouteMap(const std::string& filename){
        library.database(Assets::file(filename));
        for(std::size_t i=0;i<library.placements.size();i++){
            const auto& p=library.placements[i];const auto& r=library.records[p.record];if(!r.hasGeometry||singlePlayerBarrier(r.id))continue;
            auto b=Assets::transformed(r.bounds,p.position,p.rotation);
            int x0=int(std::floor((b.lo.x-6)/size)),x1=int(std::floor((b.hi.x+6)/size));
            int y0=int(std::floor((b.lo.y-6)/size)),y1=int(std::floor((b.hi.y+6)/size));
            if(x1-x0>300||y1-y0>300)throw std::runtime_error("map-index-budget");
            for(int x=x0;x<=x1;x++)for(int y=y0;y<=y1;y++)grid[{x,y}].push_back(i);
        }
    }
    std::pair<Vec,Vec> ground(Vec reference){
        ++queries;auto& mesh=tile(reference);Vec from=reference+Vec{0,0,1.0};
        auto hit=mesh.cast(from,{0,0,-1},3.5);
        if(!hit||std::abs(hit->normal.z)<.94)throw std::runtime_error("missing-drivable-ground");
        auto up=hit->normal;if(up.z<0)up=up*-1;
        return {{reference.x,reference.y,from.z-hit->distance},up};
    }
    RoutePose support(Vec reference,double yaw){
        if(!finite(reference)||std::abs(reference.x)>3200||std::abs(reference.y)>3200)throw std::runtime_error("outside-route-map");
        auto surface=ground(reference);RoutePose pose;pose.yaw=yaw;
        const double a=yaw*routePi/180;Vec flat{-std::sin(a),std::cos(a),0},side{-flat.y,flat.x,0};
        auto front=ground(reference+flat*2.4),rear=ground(reference-flat*2.4),left=ground(reference+side*1.0),right=ground(reference-side*1.0);
        double along=(front.first.z-rear.first.z)/4.8,across=(left.first.z-right.first.z)/2.0;
        Vec gradient=flat*along+side*across;pose.up=unit(Vec{-gradient.x,-gradient.y,1});
        if(pose.up.z<.94)throw std::runtime_error("ground-too-steep");
        double lift=0;for(auto sample:{front.first,rear.first,left.first,right.first})lift=std::max(lift,sample.z-surface.first.z-dot(gradient,sample-reference));
        // Intersecting slopes can put a footprint corner above the four
        // centre-line samples. Include those corners before deciding that a
        // road surface is an obstacle underneath the body.
        for(double f:{-1.,1.})for(double s:{-1.,1.}){
            auto corner=ground(reference+flat*(2.4*f)+side*s);
            lift=std::max(lift,corner.first.z-surface.first.z-dot(gradient,corner.first-reference));
        }
        if(lift>.45)throw std::runtime_error("ground-step-too-large");
        pose.p={reference.x,reference.y,surface.first.z+clearance+lift};
        pose.forward=unit(Vec{flat.x,flat.y,-(flat.x*pose.up.x+flat.y*pose.up.y)/pose.up.z});return pose;

    }
    // hintOnly is used only by the coarse access-search heuristic. Every
    // emitted car pose is still checked with the full Sultan volume below.
    bool clear(const RoutePose& from,const RoutePose& to,bool hintOnly=false){
        try{
            Vec delta=to.p-from.p;double range=norm(delta);if(range>.65||std::abs(delta.z)>.22){lastReason="step";return false;}
            // All poses are at most 25 cm apart. Inflate for yaw/normal change;
            // the fixed OBB sweep encloses the rotating car between samples.
            Vec up=unit(from.up+to.up),forward=unit(from.forward+to.forward),side=unit(cross(up,forward));forward=unit(cross(side,up));
            double rotation=std::acos(std::clamp(dot(from.forward,to.forward),-1.,1.))+std::acos(std::clamp(dot(from.up,to.up),-1.,1.));
            double inflation=hintOnly?.012:2.8*rotation/2+.012;
            Body body;body.half={ (hintOnly?.7:2.4)+inflation,(hintOnly?.7:1)+inflation,.70+inflation};body.axes={forward,side,up};
            Vec midpoint=(from.p+to.p)*.5,base=midpoint-Vec{0,0,clearance};
            // Only near-coplanar supporting faces are removed, at this car
            // footprint. Walls, roofs, raised objects and solids remain.
            std::function<bool(const Triangle&)> obstacle=[&](const Triangle& t){
                Vec n=unit(cross(t.b-t.a,t.c-t.a));if(n.z<0)n=n*-1;
                if(n.z<.94)return true;
                Vec flat=unit(Vec{forward.x,forward.y,0}),lateral{-flat.y,flat.x,0};
                std::vector<Vec> polygon;for(Vec vertex:{t.a,t.b,t.c}){Vec d=vertex-midpoint;polygon.push_back({dot(d,flat),dot(d,lateral),vertex.z});}
                auto clip=[](std::vector<Vec> p,int axis,double edge,bool minimum){std::vector<Vec> out;if(p.empty())return out;auto prior=p.back();bool was=minimum?prior[axis]>=edge:prior[axis]<=edge;
                    for(auto v:p){bool inside=minimum?v[axis]>=edge:v[axis]<=edge;if(was!=inside)out.push_back(prior+(v-prior)*((edge-prior[axis])/(v[axis]-prior[axis])));if(inside)out.push_back(v);prior=v;was=inside;}return out;};
                polygon=clip(std::move(polygon),0,-body.half.x-.1,true);polygon=clip(std::move(polygon),0,body.half.x+.1,false);
                polygon=clip(std::move(polygon),1,-body.half.y-.1,true);polygon=clip(std::move(polygon),1,body.half.y+.1,false);
                if(polygon.empty())return true;
                for(auto vertex:polygon){Vec xy=midpoint+flat*vertex.x+lateral*vertex.y;double expected=base.z-(up.x*(xy.x-base.x)+up.y*(xy.y-base.y))/up.z;
                    if(vertex.z>expected+.15||vertex.z<expected-.65)return true;}
                return false;
            };
            auto& mesh=tile(midpoint);
            if(auto hit=mesh.cast(from.p,range>eps?unit(delta):forward,range,&body,&obstacle)){lastReason="hit:"+std::to_string(hit->id)+":"+std::to_string(hit->distance)+":normal="+std::to_string(hit->normal.x)+","+std::to_string(hit->normal.y)+","+std::to_string(hit->normal.z);return false;}
            // Independent support under both sides prevents a centre-line
            // shortcut across a gap, a bridge edge or a different storey.
            for(double s:{-1.,1.}){
                Vec p=to.p+side*s;auto g=ground(p);
                double expected=to.p.z-clearance-(to.up.x*(p.x-to.p.x)+to.up.y*(p.y-to.p.y))/to.up.z;
                if(g.first.z-expected>.15||g.first.z-expected<-.6){lastReason="side-ground";return false;}
            }return true;
        }catch(const std::exception& e){lastReason=e.what();return false;}
    }
    bool advance(const RoutePose& start,double curvature,double length,std::vector<RoutePose>* output,RoutePose& end){
        RoutePose previous=start;const double a=start.yaw*routePi/180;
        Vec f{-std::sin(a),std::cos(a),0},right{f.y,-f.x,0};
        int count=std::max(1,int(std::ceil(std::abs(length)/.25)));
        for(int i=1;i<=count;i++){
            double d=length*i/count;Vec p=start.p;
            if(std::abs(curvature)<1e-8)p=p+f*d;
            else p=p+f*(std::sin(curvature*d)/curvature)+right*((1-std::cos(curvature*d))/curvature);
            p.z=previous.p.z;
            RoutePose next;
            try{next=support(p,start.yaw-curvature*d*180/routePi);}catch(const std::exception& e){lastReason=e.what();return false;}
            if(!clear(previous,next))return false;
            next.distance=previous.distance+norm(next.p-previous.p);
            if(output)output->push_back(next);previous=next;
        }end=previous;return true;
    }
};
}} // namespace
