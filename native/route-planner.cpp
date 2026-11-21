// GPL-2.0-or-later. Offline road-guided Hybrid A*, with swept CADB validation.
#include "route-map.hpp"
#include <queue>
#include <unordered_map>
#include <chrono>
#include <sstream>
#include <iostream>
#include <iomanip>
#include <set>
using namespace KLRM::Obstacle;
struct Road {Vec p;std::vector<int> edges;};
std::map<int,Road> roads;std::set<int> blockedRoadNodes;std::map<int,double> checkpointAccessRoads;
double roadCost(Vec a,Vec b){double distance=norm(b-a),horizontal=std::hypot(a.x-b.x,a.y-b.y),grade=std::abs(a.z-b.z)/std::max(.1,horizontal);
    // Low flood channels and steep service ramps are less suitable than the
    // surrounding street grid. They remain available when no street connects.
    return distance*(std::min(a.z,b.z)<8?6.:1.)*(grade>.18?2.:1.);
}
auto began=std::chrono::steady_clock::now();
void budget(){if(std::chrono::steady_clock::now()-began>std::chrono::seconds(150))throw std::runtime_error("route-planning-timeout");}
std::vector<Vec> guide(const std::string& file,Vec start,Vec goal,double yaw){
    roads.clear();std::ifstream in(file);if(!in)throw std::runtime_error("missing-road-data");
    std::string line;std::vector<std::pair<int,int>> edges;
    while(std::getline(in,line)){std::istringstream row(line);int kind;if(!(row>>kind))continue;
        if(kind==0){Vec p;int ignored,id;if(!(row>>p.x>>p.y>>p.z>>ignored>>id)||!finite(p)||norm(p)>15000)throw std::runtime_error("invalid-road-data");roads[id].p=p;}
        else if(kind==1){int a,b,d;if(!(row>>a>>b>>d))throw std::runtime_error("invalid-road-data");edges.push_back({a,b});}
    }
    for(auto e:edges){if(blockedRoadNodes.count(e.first)||blockedRoadNodes.count(e.second))continue;if(!roads.count(e.first)||!roads.count(e.second))throw std::runtime_error("invalid-road-edge");roads[e.first].edges.push_back(e.second);}
    if(roads.empty()||roads.size()>100000)throw std::runtime_error("invalid-road-data");
    auto closest=[&](Vec p){return std::min_element(roads.begin(),roads.end(),[&](const auto& a,const auto& b){return norm(a.second.p-p)<norm(b.second.p-p);})->first;};
    int target=closest(goal);
    if(!checkpointAccessRoads.empty()){
        double best=1e9;target=-1;
        for(const auto& access:checkpointAccessRoads)if(!blockedRoadNodes.count(access.first)&&roads.count(access.first)){
            double score=access.second+norm(roads.at(access.first).p-goal);
            if(score<best){best=score;target=access.first;}
        }
        if(target<0)throw std::runtime_error("no-road-access-to-checkpoint");
    }
    std::map<int,std::vector<int>> reverse;
    for(const auto& r:roads)for(int n:r.second.edges)reverse[n].push_back(r.first);
    std::map<int,double> reach;std::map<int,int> terminal;std::priority_queue<std::pair<double,int>,std::vector<std::pair<double,int>>,std::greater<std::pair<double,int>>> reachQueue;
    if(checkpointAccessRoads.empty()){reach[target]=0;terminal[target]=target;reachQueue.push({0,target});}
    else for(const auto& access:checkpointAccessRoads)if(!blockedRoadNodes.count(access.first)&&roads.count(access.first)){
        double cost=access.second+norm(roads.at(access.first).p-goal);reach[access.first]=cost;terminal[access.first]=access.first;reachQueue.push({cost,access.first});
    }
    while(!reachQueue.empty()){auto item=reachQueue.top();reachQueue.pop();if(item.first!=reach[item.second])continue;for(int n:reverse[item.second]){double c=item.first+roadCost(roads[n].p,roads[item.second].p);if(!reach.count(n)||c<reach[n]){reach[n]=c;terminal[n]=terminal[item.second];reachQueue.push({c,n});}}}
    int source=-1;double best=1e9;Vec forward{-std::sin(yaw*routePi/180),std::cos(yaw*routePi/180),0};
    for(const auto& r:roads){Vec d=r.second.p-start;double distance=norm(d);if(!reach.count(r.first)||distance>180||std::abs(d.z)>2.0)continue;Vec flat=d;flat.z=0;
        double score=distance+(norm(flat)<1?0:16*std::acos(std::clamp(dot(unit(flat),forward),-1.,1.)));
        if(score<best){best=score;source=r.first;}}
    if(source<0)throw std::runtime_error("checkpoint-road-access-too-far");target=terminal.at(source);
    if(norm(roads[target].p-goal)>300)throw std::runtime_error("checkpoint-road-access-too-far");
    using Item=std::pair<double,int>;std::priority_queue<Item,std::vector<Item>,std::greater<Item>> q;
    std::map<int,double> costs;std::map<int,int> parent;costs[source]=0;q.push({norm(roads[source].p-roads[target].p),source});
    while(!q.empty()){int at=q.top().second;q.pop();if(at==target)break;for(int n:roads[at].edges){double c=costs[at]+roadCost(roads[n].p,roads[at].p);if(!costs.count(n)||c<costs[n]){costs[n]=c;parent[n]=at;q.push({c+norm(roads[n].p-roads[target].p),n});}}}
    if(!costs.count(target))throw std::runtime_error("no-road-route");
    std::vector<Vec> result{goal};for(int n=target;;n=parent.at(n)){result.push_back(roads[n].p);if(n==source)break;}
    std::reverse(result.begin(),result.end());return result;
}
bool connect(RouteMap& map,const RoutePose& from,Vec target,std::vector<RoutePose>& output,RoutePose& end,double tolerance){
    Vec delta=target-from.p;delta.z=0;double distance=norm(delta);
    if(norm(target-from.p)<=tolerance){end=from;return true;}
    double a=from.yaw*routePi/180;Vec forward{-std::sin(a),std::cos(a),0},right{forward.y,-forward.x,0};
    double x=dot(delta,forward),y=dot(delta,right),curvature=2*y/(distance*distance);
    if(x<=0||std::abs(curvature)>1./4||distance>32)return false;
    double angle=2*std::atan2(y,x),length=std::abs(curvature)<1e-8?distance:angle/curvature;
    if(length<0)return false;
    // A checkpoint is a volume. Stop at its accessible edge: validating the
    // remaining arc to its centre can incorrectly reject an already valid
    // arrival when the centre is next to a wall or beyond a road shoulder.
    std::vector<RoutePose> segment;RoutePose previous=from;
    int count=std::max(1,int(std::ceil(length/.25)));
    for(int i=0;i<count;i++){
        if(!map.advance(previous,curvature,length/count,&segment,end))return false;
        if(norm(end.p-target)<=tolerance){output.insert(output.end(),segment.begin(),segment.end());return true;}
        previous=end;
    }
    return false;
}
bool roadConnect(RouteMap& map,const RoutePose& from,Vec target,double finalYaw,std::vector<RoutePose>& output,RoutePose& end,double tolerance){
    if(!std::isfinite(finalYaw))return connect(map,from,target,output,end,tolerance);
    const double goalZ=target.z;Vec delta=target-from.p;delta.z=0;double distance=norm(delta);
    double a=finalYaw*routePi/180;Vec finalForward{-std::sin(a),std::cos(a),0};
    if(distance<tolerance&&std::abs(target.z-from.p.z)<2&&dot(unit(Vec{from.forward.x,from.forward.y,0}),finalForward)>.94){end=from;return true;}
    if(distance<.2||distance>90)return false;
    Vec initial=unit(Vec{from.forward.x,from.forward.y,0}),t0=initial*(distance*.9),t1=finalForward*(distance*.9),start=from.p;start.z=0;target.z=0;
    int count=int(std::ceil(distance*4/.25));RoutePose previous=from;std::vector<RoutePose> points;
    for(int i=1;i<=count;i++){
        double u=double(i)/count,u2=u*u,u3=u2*u;
        Vec p=start*(2*u3-3*u2+1)+t0*(u3-2*u2+u)+target*(-2*u3+3*u2)+t1*(u3-u2);
        Vec v=start*(6*u2-6*u)+t0*(3*u2-4*u+1)+target*(-6*u2+6*u)+t1*(3*u2-2*u);
        Vec acceleration=start*(12*u-6)+t0*(6*u-4)+target*(-12*u+6)+t1*(6*u-2);
        if(norm(v)<.1||std::abs(cross(v,acceleration).z)/std::pow(norm(v),3)>1./8)return false;
        p.z=previous.p.z;RoutePose next;try{next=map.support(p,std::atan2(-v.x,v.y)*180/routePi);}catch(const std::exception&){return false;}
        if(!map.clear(previous,next))return false;next.distance=previous.distance+norm(next.p-previous.p);points.push_back(next);previous=next;
    }
    if(std::abs(previous.p.z-goalZ)>2)return false;end=previous;output.insert(output.end(),points.begin(),points.end());return true;
}
// Obstacle-aware distance for the last access. A Euclidean-only search keeps
// exploring the same wall when a pier/yard entrance is around the building.
// This smaller point footprint supplies guidance, never an executable route.
class AccessHint {
    struct Cell {Vec p;double distance;};
    std::map<std::tuple<int,int,int>,Cell> cells;
    Vec goal;static constexpr double spacing=2;
    auto key(Vec p)const{return std::make_tuple(int(std::round((p.x-goal.x)/spacing)),int(std::round((p.y-goal.y)/spacing)),int(std::round(p.z/.5)));}
    RoutePose pose(RouteMap& map,Vec p){auto g=map.ground(p);RoutePose out;out.p={p.x,p.y,g.first.z+map.clearance};out.up=g.second;out.forward=unit(Vec{0,1,-out.up.y/out.up.z});return out;}
public:
    AccessHint(RouteMap& map,Vec start,Vec target,double tolerance):goal(target){
        using Key=std::tuple<int,int,int>;using Item=std::pair<double,Key>;
        std::priority_queue<Item,std::vector<Item>,std::greater<Item>> queue;
        int seed=int(std::ceil(tolerance/spacing));
        for(int x=-seed;x<=seed;x++)for(int y=-seed;y<=seed;y++)try{
            auto p=pose(map,target+Vec{x*spacing,y*spacing,0});if(norm(p.p-target)>tolerance||!map.clear(p,p,true))continue;
            auto id=key(p.p);cells[id]={p.p,0};queue.push({0,id});
        }catch(const std::exception&){}
        unsigned expanded=0;double reached=1e9;
        while(!queue.empty()&&expanded<30000){
            budget();auto item=queue.top();queue.pop();auto current=cells.at(item.second);if(item.first!=current.distance)continue;
            if(current.distance>reached+40)break;expanded++;
            if(norm(current.p-start)<3)reached=std::min(reached,current.distance);
            for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++)if(x||y){
                Vec endpoint=current.p+Vec{x*spacing,y*spacing,0};
                if(endpoint.x<std::min(start.x,target.x)-200||endpoint.x>std::max(start.x,target.x)+200||endpoint.y<std::min(start.y,target.y)-200||endpoint.y>std::max(start.y,target.y)+200)continue;
                RoutePose previous;try{previous=pose(map,current.p);}catch(const std::exception&){continue;}
                bool valid=true;double distance=0;
                int steps=6;
                for(int i=1;i<=steps;i++)try{Vec p=current.p+Vec{x*spacing*i/steps,y*spacing*i/steps,0};p.z=previous.p.z;auto next=pose(map,p);if(!map.clear(previous,next,true)){valid=false;break;}distance+=norm(next.p-previous.p);previous=next;}catch(const std::exception&){valid=false;break;}
                if(!valid)continue;auto id=key(previous.p);double cost=current.distance+distance;
                auto found=cells.find(id);if(found!=cells.end()&&found->second.distance<=cost)continue;
                cells[id]={previous.p,cost};queue.push({cost,id});
            }
        }
        Vec lo=target,hi=target;for(const auto& cell:cells){const auto& p=cell.second.p;lo={std::min(lo.x,p.x),std::min(lo.y,p.y),std::min(lo.z,p.z)};hi={std::max(hi.x,p.x),std::max(hi.y,p.y),std::max(hi.z,p.z)};}
        std::cerr<<"ROUTE_ACCESS_HINT "<<expanded<<" cells "<<cells.size()<<" reached "<<reached<<" bounds "<<lo.x<<' '<<lo.y<<' '<<lo.z<<" / "<<hi.x<<' '<<hi.y<<' '<<hi.z<<'\n';
    }
    double knownDistance(Vec p)const{
        auto id=key(p);double best=1e9;auto [x,y,z]=id;
        for(int dz=-3;dz<=3;dz++){auto found=cells.find({x,y,z+dz});if(found!=cells.end())best=std::min(best,found->second.distance+norm(found->second.p-p));}
        return best;
    }
    double distance(Vec p)const{double best=knownDistance(p);return best<1e9?best:norm(p-goal)*3+100;}
};
std::vector<RoutePose> leg(RouteMap& map,RoutePose start,Vec target,double tolerance,double finalYaw=std::numeric_limits<double>::quiet_NaN()){
    struct Node {RoutePose pose;double cost=0;int parent=-1;double curvature=0,length=3;};
    std::vector<Node> nodes{{start,0,-1,0,0}};
    using Item=std::pair<double,int>;std::priority_queue<Item,std::vector<Item>,std::greater<Item>> queue;
    std::unordered_map<std::string,double> visited;
    auto key=[](RoutePose p){int yaw=int(std::floor((p.yaw-std::floor(p.yaw/360)*360)/5));return std::to_string(int(std::floor(p.p.x/.5)))+","+std::to_string(int(std::floor(p.p.y/.5)))+","+std::to_string(int(std::floor(p.p.z)))+","+std::to_string(yaw);};
    std::unique_ptr<AccessHint> hint;
    // Direct connections stay cheap; build the detour heuristic only when a
    // full-volume connection actually fails at the final checkpoint.
    if(!std::isfinite(finalYaw)){
        RoutePose end;std::vector<RoutePose> direct;if(connect(map,start,target,direct,end,tolerance))return direct;
        hint=std::make_unique<AccessHint>(map,start.p,target,tolerance);
        if(hint->knownDistance(start.p)>=1e9&&checkpointAccessRoads.empty()){
            for(const auto& road:roads)if(norm(road.second.p-target)<300){double cost=hint->knownDistance(road.second.p);if(cost<1e9)checkpointAccessRoads[road.first]=cost;}
            if(!checkpointAccessRoads.empty())throw std::runtime_error("checkpoint-needs-other-road-access");
        }
    }
    queue.push({hint?hint->distance(start.p):norm(start.p-target),0});int expanded=0;
    while(!queue.empty()){
        budget();int index=queue.top().second;queue.pop();auto current=nodes[index];
        if(++expanded>(std::isfinite(finalYaw)?2500:20000)){
            auto best=std::min_element(nodes.begin(),nodes.end(),[&](const auto& a,const auto& b){return norm(a.pose.p-target)<norm(b.pose.p-target);});
            std::cerr<<"ROUTE_CLOSEST "<<best->pose.p.x<<" "<<best->pose.p.y<<" "<<best->pose.p.z<<" yaw "<<best->pose.yaw<<" distance "<<norm(best->pose.p-target)<<" target "<<target.x<<" "<<target.y<<" "<<target.z<<" start "<<start.p.x<<" "<<start.p.y<<" "<<start.p.z<<" yaw "<<start.yaw<<" nodes "<<nodes.size()<<"\n";
            throw std::runtime_error("route-access-search-limit");
        }
        RoutePose end;std::vector<RoutePose> finish;
        if(roadConnect(map,current.pose,target,finalYaw,finish,end,tolerance)){
            std::vector<int> trace;for(int i=index;nodes[i].parent>=0;i=nodes[i].parent)trace.push_back(i);std::reverse(trace.begin(),trace.end());
            std::vector<RoutePose> output;auto pose=start;
            for(int i:trace){if(!map.advance(pose,nodes[i].curvature,nodes[i].length,&output,end))throw std::runtime_error("route-recheck-failed");pose=end;}
            output.insert(output.end(),finish.begin(),finish.end());return output;
        }
        const std::vector<double> curvatures=hint?std::vector<double>{0.,1./16,-1./16,1./8,-1./8,1./6,-1./6,1./4,-1./4}:std::vector<double>{0.,1./16,-1./16,1./8,-1./8};
        for(double length:{1.5,-1.5})for(double curvature:curvatures){
            if(!map.advance(current.pose,curvature,length,nullptr,end))continue;
            if(norm(end.p-start.p)>std::max(hint?250.:100.,norm(target-start.p)+(hint?200:50)))continue;
            double cost=current.cost+(length>0?1.5:2.5)+std::abs(curvature)*.3;auto id=key(end);
            if(visited.count(id)&&visited[id]<=cost)continue;visited[id]=cost;
            nodes.push_back({end,cost,index,curvature,length});double headingCost=0;if(std::isfinite(finalYaw)){double angle=(end.yaw-finalYaw)*routePi/180;headingCost=4*std::abs(std::atan2(std::sin(angle),std::cos(angle)));}
            queue.push({cost+1.4*(hint?hint->distance(end.p):norm(end.p-target))+headingCost,int(nodes.size()-1)});
        }
    }auto best=std::min_element(nodes.begin(),nodes.end(),[&](const auto& a,const auto& b){return norm(a.pose.p-target)<norm(b.pose.p-target);});std::cerr<<"ROUTE_CLOSEST "<<best->pose.p.x<<" "<<best->pose.p.y<<" "<<best->pose.p.z<<" yaw "<<best->pose.yaw<<" distance "<<norm(best->pose.p-target)<<" nodes "<<nodes.size()<<"\n";throw std::runtime_error("checkpoint-access-blocked:"+map.lastReason+":"+std::to_string(expanded));
}
int main(int argc,char** argv){try{
    if(argc!=13)throw std::runtime_error("usage: planner map roads output sx sy sz heading gx gy gz radius revision");
    Vec start{std::stod(argv[4]),std::stod(argv[5]),std::stod(argv[6])},goal{std::stod(argv[8]),std::stod(argv[9]),std::stod(argv[10])};double yaw=std::stod(argv[7]),radius=std::stod(argv[11]);unsigned long revision=std::stoul(argv[12]);
    if(!finite(start)||!finite(goal)||!std::isfinite(yaw)||radius<.5||radius>20)throw std::runtime_error("invalid-route-query");
    RouteMap map(argv[1]);auto surface=map.ground(start);map.clearance=start.z-surface.first.z;
    if(map.clearance<.2||map.clearance>1.5)throw std::runtime_error("unsupported-ground-clearance");
    RoutePose pose=map.support(start,yaw);pose.p=start;
    std::vector<Vec> targets=norm(goal-start)<50?std::vector<Vec>{goal}:guide(argv[2],start,goal,yaw);
    std::vector<RoutePose> route{pose};std::size_t skipped=0;
    std::size_t i=0;unsigned reroutes=0;
    while(i<targets.size()){
        budget();if(i+1<targets.size()&&norm(targets[i]-pose.p)<6){skipped++;i++;continue;}
        double finalYaw=std::numeric_limits<double>::quiet_NaN();
        if(i+1<targets.size()){Vec next=targets[i+1]-(i?targets[i-1]:pose.p);finalYaw=std::atan2(-next.x,next.y)*180/routePi;}
        std::vector<RoutePose> pieces;
        try{pieces=leg(map,pose,targets[i],i+1==targets.size()?std::max(.25,radius-.5):3,finalYaw);}
        catch(const std::exception& e){
            if(++reroutes>24)throw;
            if(i+1==targets.size()){
                if(std::string(e.what())!="checkpoint-needs-other-road-access")throw;
                std::cerr<<"ROUTE_REPLAN checkpoint-road-access\n";
                pose=route.front();route.resize(1);targets=guide(argv[2],pose.p,goal,pose.yaw);i=0;continue;
            }
            auto bad=std::min_element(roads.begin(),roads.end(),[&](const auto& a,const auto& b){return norm(a.second.p-targets[i])<norm(b.second.p-targets[i]);});
            if(bad==roads.end())throw;blockedRoadNodes.insert(bad->first);
            const Vec failed=bad->second.p;
            for(const auto& r:roads)if(norm(r.second.p-failed)<20&&std::abs(r.second.p.z-failed.z)<3&&norm(r.second.p-goal)>30)blockedRoadNodes.insert(r.first);
            std::cerr<<"ROUTE_REPLAN "<<bad->first<<" "<<e.what()<<"\n";
            pose=route.front();route.resize(1);targets=guide(argv[2],pose.p,goal,pose.yaw);i=0;continue;
        }
        if(!pieces.empty()){pose=pieces.back();route.insert(route.end(),pieces.begin(),pieces.end());}
        if(route.size()>180000)throw std::runtime_error("route-length-budget");
        if(i%10==0)std::cerr<<"ROUTE_PROGRESS "<<i<<' '<<targets.size()<<' '<<pose.distance<<'\n';i++;
    }
    if(norm(route.back().p-goal)>std::max(.25,radius-.5))throw std::runtime_error("checkpoint-height-or-access-mismatch");
    std::ofstream out(argv[3]);if(!out)throw std::runtime_error("route-file-unwritable");out<<std::setprecision(12);
    out<<"RMR1 "<<revision<<' '<<goal.x<<' '<<goal.y<<' '<<goal.z<<' '<<radius<<' '<<route.size()<<'\n';
    for(const auto& p:route)out<<p.distance<<' '<<p.p.x<<' '<<p.p.y<<' '<<p.p.z<<' '<<p.forward.x<<' '<<p.forward.y<<' '<<p.forward.z<<' '<<p.up.x<<' '<<p.up.y<<' '<<p.up.z<<'\n';
    out.close();if(!out)throw std::runtime_error("route-file-write-failed");
    std::cout<<"{\"ok\":true,\"metres\":"<<pose.distance<<",\"samples\":"<<route.size()<<",\"queries\":"<<map.queries<<",\"seconds\":"<<std::chrono::duration<double>(std::chrono::steady_clock::now()-began).count()<<"}\n";
}catch(const std::exception& e){std::cerr<<"ROUTE_ERROR "<<e.what()<<'\n';return 1;}}
