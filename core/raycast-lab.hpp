// GPL-2.0-or-later. Geometry and trajectory laboratory; not a GTA physics engine.
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <numeric>
#include <optional>
#include <stdexcept>
#include <vector>
#include <functional>

namespace KLRM { namespace Obstacle {
constexpr double eps=1e-9;
struct Vec { double x=0,y=0,z=0; double operator[](int i)const{return i==0?x:i==1?y:z;} };
inline Vec operator+(Vec a,Vec b){return {a.x+b.x,a.y+b.y,a.z+b.z};}
inline Vec operator-(Vec a,Vec b){return {a.x-b.x,a.y-b.y,a.z-b.z};}
inline Vec operator*(Vec a,double b){return {a.x*b,a.y*b,a.z*b};}
inline double dot(Vec a,Vec b){return a.x*b.x+a.y*b.y+a.z*b.z;}
inline Vec cross(Vec a,Vec b){return {a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x};}
inline double norm(Vec a){return std::sqrt(dot(a,a));}
inline bool finite(Vec a){return std::isfinite(a.x)&&std::isfinite(a.y)&&std::isfinite(a.z);}
inline Vec unit(Vec a){double n=norm(a);if(!finite(a)||n<eps)throw std::invalid_argument("invalid direction");return a*(1/n);}
struct Box { Vec lo,hi; };
inline bool valid(Box b){return finite(b.lo)&&finite(b.hi)&&b.lo.x<=b.hi.x&&b.lo.y<=b.hi.y&&b.lo.z<=b.hi.z;}
inline bool contains(Box b,Box a){for(int i=0;i<3;i++)if(a.lo[i]<b.lo[i]-eps||a.hi[i]>b.hi[i]+eps)return false;return true;}
inline Box merge(Box a,Box b){return {{std::min(a.lo.x,b.lo.x),std::min(a.lo.y,b.lo.y),std::min(a.lo.z,b.lo.z)},{std::max(a.hi.x,b.hi.x),std::max(a.hi.y,b.hi.y),std::max(a.hi.z,b.hi.z)}};}
inline Box expand(Box b,Vec h){return {b.lo-h,b.hi+h};}
inline std::optional<double> rayBox(Vec p,Vec d,double range,Box b){
    double low=0,high=range;
    for(int i=0;i<3;i++){
        if(std::abs(d[i])<eps){if(p[i]<b.lo[i]||p[i]>b.hi[i])return {};continue;}
        double a=(b.lo[i]-p[i])/d[i],c=(b.hi[i]-p[i])/d[i];if(a>c)std::swap(a,c);
        low=std::max(low,a);high=std::min(high,c);if(low>high+eps)return {};
    }
    return low;
}
struct Triangle { Vec a,b,c; int id=0; };
inline Box bounds(Triangle t){return merge(merge({t.a,t.a},{t.b,t.b}),{t.c,t.c});}
inline std::optional<double> rayTriangle(Vec origin,Vec direction,double range,Triangle t){
    const Vec e=t.b-t.a,f=t.c-t.a,p=cross(direction,f);const double det=dot(e,p);
    if(std::abs(det)<eps)return {};
    const Vec q=origin-t.a;const double u=dot(q,p)/det;if(u< -eps||u>1+eps)return {};
    const Vec r=cross(q,e);const double v=dot(direction,r)/det;if(v< -eps||u+v>1+eps)return {};
    const double distance=dot(f,r)/det;if(distance< -eps||distance>range+eps)return {};
    return std::max(0.0,distance);
}
struct Body { std::array<Vec,3> axes{{{1,0,0},{0,1,0},{0,0,1}}};Vec half{2.4,1.0,.75}; };
inline bool valid(Body b){
    if(!finite(b.half)||b.half.x<=0||b.half.y<=0||b.half.z<=0)return false;
    for(int i=0;i<3;i++){if(!finite(b.axes[i])||std::abs(norm(b.axes[i])-1)>1e-6)return false;for(int j=0;j<i;j++)if(std::abs(dot(b.axes[i],b.axes[j]))>1e-6)return false;}return true;
}
inline Vec worldHalf(Body b){
    Vec h;for(int i=0;i<3;i++){h.x+=std::abs(b.axes[i].x)*b.half[i];h.y+=std::abs(b.axes[i].y)*b.half[i];h.z+=std::abs(b.axes[i].z)*b.half[i];}return h;
}
// Continuous SAT for a translating, fixed-orientation box and a triangle.
// Includes the vehicle volume, so a narrow pole between sampled rays is caught.
inline std::optional<double> sweepTriangle(Vec p,Vec direction,double range,Body body,Triangle t){
    std::array<Vec,13> axes;int count=0;
    for(auto a:body.axes)axes[count++]=a;
    axes[count++]=cross(t.b-t.a,t.c-t.a);
    for(auto edge:{t.b-t.a,t.c-t.b,t.a-t.c})for(auto a:body.axes)axes[count++]=cross(edge,a);
    double low=0,high=range;
    for(auto axis:axes){
        if(dot(axis,axis)<eps*eps)continue;
        const double first=dot(t.a,axis),second=dot(t.b,axis),third=dot(t.c,axis);
        const double mn=std::min({first,second,third}),mx=std::max({first,second,third});
        double radius=0;for(int i=0;i<3;i++)radius+=std::abs(dot(axis,body.axes[i]))*body.half[i];
        const double centre=dot(p,axis),velocity=dot(direction,axis);
        if(std::abs(velocity)<eps){if(centre<mn-radius-eps||centre>mx+radius+eps)return {};continue;}
        double a=(mn-radius-centre)/velocity,b=(mx+radius-centre)/velocity;if(a>b)std::swap(a,b);
        low=std::max(low,a);high=std::min(high,b);if(low>high+eps)return {};
    }
    return low;
}
struct Sphere { Vec centre;double radius=0;int id=0; };
struct SolidBox { Vec centre;Body body;int id=0; };
// Exact fixed-orientation OBB/OBB translation, including initial containment.
inline std::optional<double> sweepBox(Vec p,Vec d,double range,Body own,SolidBox other){
    std::array<Vec,15> axes;int count=0;
    for(auto a:own.axes)axes[count++]=a;
    for(auto a:other.body.axes)axes[count++]=a;
    for(auto a:own.axes)for(auto b:other.body.axes)axes[count++]=cross(a,b);
    double lo=0,hi=range;Vec relative=p-other.centre;
    for(auto a:axes){
        if(dot(a,a)<eps*eps)continue;
        double radius=0;for(int i=0;i<3;i++)radius+=std::abs(dot(a,own.axes[i]))*own.half[i]+std::abs(dot(a,other.body.axes[i]))*other.body.half[i];
        double start=dot(relative,a),v=dot(d,a);
        if(std::abs(v)<eps){if(std::abs(start)>radius+eps)return {};continue;}
        double x=(-radius-start)/v,y=(radius-start)/v;if(x>y)std::swap(x,y);
        lo=std::max(lo,x);hi=std::min(hi,y);if(lo>hi+eps)return {};
    }
    return lo;
}
// Ray against a rounded box: solve squared point-to-box distance on each
// interval separated by its six slab boundaries. This is the exact sweep of
// an oriented box against a sphere, without tessellating or shrinking it.
inline std::optional<double> sweepSphere(Vec p,Vec d,double range,Body body,Sphere sphere){
    Vec offset=sphere.centre-p;
    std::array<double,3> q{},v{};std::vector<double> times{0,range};
    for(int i=0;i<3;i++){
        q[i]=dot(offset,body.axes[i]);v[i]=-dot(d,body.axes[i]);
        if(std::abs(v[i])>eps)for(double side:{-body.half[i],body.half[i]}){double t=(side-q[i])/v[i];if(t>0&&t<range)times.push_back(t);}
    }
    auto distance=[&](double t){double sum=0;for(int i=0;i<3;i++){double a=std::max(0.,std::abs(q[i]+v[i]*t)-body.half[i]);sum+=a*a;}return sum-sphere.radius*sphere.radius;};
    std::sort(times.begin(),times.end());
    for(std::size_t i=0;i<times.size();i++){
        double left=times[i];if(distance(left)<=eps)return left;if(i+1==times.size())break;
        double right=times[i+1],mid=(left+right)/2,A=0,B=0,C=-sphere.radius*sphere.radius;
        for(int j=0;j<3;j++){
            double x=q[j]+v[j]*mid;if(std::abs(x)<=body.half[j])continue;
            double a=q[j]-(x>0?body.half[j]:-body.half[j]);A+=v[j]*v[j];B+=2*a*v[j];C+=a*a;
        }
        if(A<eps*eps)continue;
        double discriminant=B*B-4*A*C;if(discriminant<0)continue;
        double t=(-B-std::sqrt(discriminant))/(2*A);
        if(t>=left-eps&&t<=right+eps)return std::clamp(t,left,right);
    }
    return {};
}
struct Hit { double distance;int id;Vec normal{}; };
class Mesh {
    struct Node { Box box;int left=-1,right=-1;std::size_t begin=0,end=0; };
    std::vector<Triangle> triangles;
    std::vector<Sphere> spheres;
    std::vector<SolidBox> solids;
    std::vector<std::size_t> order;
    std::vector<Node> nodes;
    int build(std::size_t begin,std::size_t end){
        Box box=bounds(triangles[order[begin]]);for(auto i=begin+1;i<end;i++)box=merge(box,bounds(triangles[order[i]]));
        int index=static_cast<int>(nodes.size());nodes.push_back({box,-1,-1,begin,end});
        if(end-begin>4){
            Vec size=box.hi-box.lo;int axis=size.y>size.x?1:0;if(size.z>size[axis])axis=2;
            auto middle=begin+(end-begin)/2;
            std::nth_element(order.begin()+begin,order.begin()+middle,order.begin()+end,[&](auto a,auto b){auto x=bounds(triangles[a]),y=bounds(triangles[b]);return x.lo[axis]+x.hi[axis]<y.lo[axis]+y.hi[axis];});
            int left=build(begin,middle),right=build(middle,end);nodes[index].left=left;nodes[index].right=right;
        }
        return index;
    }
    void query(int index,Vec p,Vec d,double range,const Body* body,std::optional<Hit>& hit,const std::function<bool(const Triangle&)>* filter=nullptr)const{
        const auto& node=nodes[index];double limit=hit?hit->distance:range;
        if(!rayBox(p,d,limit,body?expand(node.box,worldHalf(*body)):node.box))return;
        if(node.left>=0){query(node.left,p,d,range,body,hit,filter);query(node.right,p,d,range,body,hit,filter);return;}
        for(auto i=node.begin;i<node.end;i++){
            auto t=triangles[order[i]];if(filter&&!(*filter)(t))continue;auto distance=body?sweepTriangle(p,d,limit,*body,t):rayTriangle(p,d,limit,t);
            if(distance&&(!hit||*distance<hit->distance)){hit=Hit{*distance,t.id,unit(cross(t.b-t.a,t.c-t.a))};limit=*distance;}
        }
    }
public:
    explicit Mesh(std::vector<Triangle> data,std::vector<Sphere> balls={},std::vector<SolidBox> boxes={}):triangles(std::move(data)),spheres(std::move(balls)),solids(std::move(boxes)){
        if(spheres.size()>10000||solids.size()>20000)throw std::invalid_argument("primitive bound exceeded");
        for(auto s:spheres)if(!finite(s.centre)||!std::isfinite(s.radius)||s.radius<=0)throw std::invalid_argument("invalid sphere");
        for(auto b:solids)if(!finite(b.centre)||!valid(b.body))throw std::invalid_argument("invalid solid box");
        if(triangles.size()>200000)throw std::invalid_argument("mesh exceeds laboratory bound");
        for(auto t:triangles)if(!finite(t.a)||!finite(t.b)||!finite(t.c)||norm(cross(t.b-t.a,t.c-t.a))<eps)throw std::invalid_argument("invalid triangle");
        order.resize(triangles.size());std::iota(order.begin(),order.end(),0);if(!order.empty())build(0,order.size());
    }
    std::optional<Hit> cast(Vec p,Vec d,double range,const Body* body=nullptr,const std::function<bool(const Triangle&)>* filter=nullptr)const{
        if(!finite(p)||!finite(d)||std::abs(norm(d)-1)>1e-6||!std::isfinite(range)||range<0||(body&&!valid(*body)))throw std::invalid_argument("invalid query");
        std::optional<Hit> hit;if(!nodes.empty())query(0,p,d,range,body,hit,filter);
        Body point;if(!body)point.half={0,0,0};const Body& shape=body?*body:point;
        auto accept=[&](std::optional<double> distance,int id){if(distance&&(!hit||*distance<hit->distance))hit=Hit{*distance,id};};
        for(auto s:spheres)accept(sweepSphere(p,d,hit?hit->distance:range,shape,s),s.id);
        for(auto b:solids)accept(sweepBox(p,d,hit?hit->distance:range,shape,b),b.id);
        return hit;
    }
};
struct TrackedBox { Box box;Vec velocity;double stamp=0;int id=0; };
enum class Quality { Known,Unknown };
struct SensorResult { Quality quality=Quality::Unknown;std::optional<Hit> hit;const char* reason="missing-world";int peer=0;unsigned excluded=0; };
struct World {
    const Mesh* mesh=nullptr;Box coverage{};bool staticComplete=false,dynamicsComplete=false;
    std::vector<TrackedBox> vehicles;
    double maximumAge=.30;
    SensorResult sense(Vec p,Vec direction,double range,Body body,double now,double predictionSeconds=5)const{
        if(!mesh||!staticComplete||!dynamicsComplete)return {};
        if(!valid(coverage)||!valid(body)||!finite(p)||!finite(direction)||std::abs(norm(direction)-1)>1e-6||!std::isfinite(range)||range<0||!std::isfinite(now)||!std::isfinite(maximumAge)||maximumAge<=0||!std::isfinite(predictionSeconds)||predictionSeconds<0||predictionSeconds>10)return {Quality::Unknown,{},"invalid-query"};
        const Vec h=worldHalf(body);Box path=merge({p-h,p+h},{p+direction*range-h,p+direction*range+h});
        if(!contains(coverage,path))return {Quality::Unknown,{},"unmapped-corridor"};
        for(auto v:vehicles)if(!valid(v.box)||!finite(v.velocity)||norm(v.velocity)>100||!std::isfinite(v.stamp)||now-v.stamp>maximumAge||v.stamp>now+.001)return {Quality::Unknown,{},"stale-vehicle-data",v.id};
        SensorResult result{Quality::Known,mesh->cast(p,direction,range,&body),"known-world"};
        for(auto v:vehicles){
            // Conservative occupancy envelope, not a physical impact prediction.
            Vec offset=v.velocity*(now-v.stamp),future=v.velocity*predictionSeconds;
            Box current{v.box.lo+offset,v.box.hi+offset};Box predicted=merge(current,{current.lo+future,current.hi+future});
            auto distance=rayBox(p,direction,result.hit?result.hit->distance:range,expand(predicted,h));
            if(distance&&(!result.hit||*distance<result.hit->distance)){result.hit=Hit{*distance,v.id};result.peer=v.id;}
        }
        return result;
    }
};
using Polynomial=std::vector<double>;
inline double evaluate(const Polynomial& p,double x){double value=0;for(auto i=p.rbegin();i!=p.rend();++i)value=value*x+*i;return value;}
inline Polynomial derivative(const Polynomial& p){Polynomial d;for(std::size_t i=1;i<p.size();i++)d.push_back(i*p[i]);return d;}
inline std::vector<double> roots01(Polynomial p){
    while(p.size()>1&&std::abs(p.back())<1e-12)p.pop_back();
    if(p.size()<2)return {};
    auto boundaries=roots01(derivative(p));boundaries.insert(boundaries.begin(),0);boundaries.push_back(1);
    std::vector<double> roots;
    for(auto x:boundaries)if(std::abs(evaluate(p,x))<1e-9)roots.push_back(x);
    for(std::size_t i=1;i<boundaries.size();i++){
        double lo=boundaries[i-1],hi=boundaries[i],atLo=evaluate(p,lo),atHi=evaluate(p,hi);
        if(atLo*atHi>=0)continue;
        for(int step=0;step<60;step++){double mid=(lo+hi)/2,value=evaluate(p,mid);if(atLo*value<=0){hi=mid;}else{lo=mid;atLo=value;}}
        roots.push_back((lo+hi)/2);
    }
    std::sort(roots.begin(),roots.end());roots.erase(std::unique(roots.begin(),roots.end(),[](double a,double b){return std::abs(a-b)<1e-7;}),roots.end());return roots;
}
struct State { double position=0,speed=0,acceleration=0,jerk=0; };
struct Limits { double speed=8,acceleration=1.5,deceleration=3,jerk=2; };
struct StopPlan {
    Polynomial position,velocity,acceleration,jerk;
    double duration=0,target=0;
    State at(double time)const{
        // The polynomial has these exact terminal boundary conditions. Avoid
        // a tiny negative speed from floating-point cancellation on restart.
        if(time>=duration)return {target,0,0,0};
        double u=std::clamp(time/duration,0.0,1.0);
        return {evaluate(position,u),evaluate(velocity,u)/duration,evaluate(acceleration,u)/(duration*duration),evaluate(jerk,u)/(duration*duration*duration)};
    }
};
inline std::optional<StopPlan> planStop(State start,double target,Limits limits){
    if(!std::isfinite(start.position)||!std::isfinite(start.speed)||!std::isfinite(start.acceleration)||!std::isfinite(target)||!std::isfinite(limits.speed)||!std::isfinite(limits.acceleration)||!std::isfinite(limits.deceleration)||!std::isfinite(limits.jerk)||target<=start.position+1e-6||start.speed<0||limits.speed<=0||limits.acceleration<=0||limits.deceleration<=0||limits.jerk<=0||start.speed>limits.speed+1e-6||start.acceleration>limits.acceleration+1e-6||start.acceleration< -limits.deceleration-1e-6)return {};
    const double distance=target-start.position;
    for(double time=.10;time<=60;time*=1.025){
        double v=start.speed*time,a=start.acceleration*time*time;
        StopPlan p; p.duration=time;p.target=target;
        p.position={start.position,v,a/2,10*distance-6*v-1.5*a,-15*distance+8*v+1.5*a,6*distance-3*v-.5*a};
        if(!std::all_of(p.position.begin(),p.position.end(),[](double x){return std::isfinite(x);}))return {};
        p.velocity=derivative(p.position);p.acceleration=derivative(p.velocity);p.jerk=derivative(p.acceleration);
        bool feasible=true;
        auto velocityTimes=roots01(p.acceleration);velocityTimes.push_back(0);velocityTimes.push_back(1);
        for(auto u:velocityTimes){double speed=evaluate(p.velocity,u)/time;if(!std::isfinite(speed)||speed< -1e-7||speed>limits.speed+1e-7)feasible=false;}
        auto accelerationTimes=roots01(p.jerk);accelerationTimes.push_back(0);accelerationTimes.push_back(1);
        for(auto u:accelerationTimes){double accel=evaluate(p.acceleration,u)/(time*time);if(!std::isfinite(accel)||accel< -limits.deceleration-1e-7||accel>limits.acceleration+1e-7)feasible=false;}
        auto jerkTimes=roots01(derivative(p.jerk));jerkTimes.push_back(0);jerkTimes.push_back(1);
        for(auto u:jerkTimes){double jerk=evaluate(p.jerk,u)/(time*time*time);if(!std::isfinite(jerk)||std::abs(jerk)>limits.jerk+1e-7)feasible=false;}
        if(feasible)return p;
    }
    return {};
}
}} // namespace KLRM::Obstacle
// Compatibility for the independent mathematical lab.
namespace rakmagic_lab = KLRM::Obstacle;
