// GPL-2.0-or-later. Independently implemented, bounded GTA/ColAndreas reader.
// Format references (not linked/copied code): DragonFF gtaLib/col.py and
// ColAndreas WizardApp/src/BuildManager.cpp, cadf version 2.
#pragma once
#include "raycast-lab.hpp"
#include <cstdint>
#include <cstring>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <string>

namespace KLRM { namespace Obstacle { namespace Assets {
constexpr std::size_t maximumBytes=128u*1024*1024,maximumModels=30000,maximumPlacements=1000000;
struct Error:std::runtime_error{using std::runtime_error::runtime_error;};
struct Bytes {
    std::vector<uint8_t> data;
    void span(std::size_t offset,std::size_t count,std::size_t end)const{
        if(end>data.size()||offset>end||count>end-offset)throw Error("truncated or out-of-range collision data");
    }
    uint8_t u8(std::size_t p)const{span(p,1,data.size());return data[p];}
    uint16_t u16(std::size_t p)const{span(p,2,data.size());return uint16_t(data[p])|(uint16_t(data[p+1])<<8);}
    uint32_t u32(std::size_t p)const{span(p,4,data.size());return uint32_t(data[p])|(uint32_t(data[p+1])<<8)|(uint32_t(data[p+2])<<16)|(uint32_t(data[p+3])<<24);}
    double f32(std::size_t p)const{uint32_t bits=u32(p);float f;std::memcpy(&f,&bits,4);if(!std::isfinite(f)||std::abs(f)>1000000)throw Error("non-finite or excessive collision coordinate");return f;}
    Vec vec(std::size_t p)const{return {f32(p),f32(p+4),f32(p+8)};}
    std::string text(std::size_t p,std::size_t count)const{
        span(p,count,data.size());std::string s;
        for(std::size_t i=0;i<count&&data[p+i];i++){unsigned char c=data[p+i];if(c<32||c>126)throw Error("invalid COL model name");s+=char(c>='A'&&c<='Z'?c+32:c);}
        if(s.empty())throw Error("empty COL model name");return s;
    }
};
inline std::shared_ptr<Bytes> file(const std::string& path){
    if(path.empty()||path.size()>4096||path.find('\0')!=std::string::npos)throw Error("invalid asset path");
    std::ifstream in(path,std::ios::binary|std::ios::ate);if(!in)throw Error("collision file cannot be opened");
    auto length=in.tellg();if(length<=0||uint64_t(length)>maximumBytes)throw Error("collision file size rejected");
    auto b=std::make_shared<Bytes>();b->data.resize(std::size_t(length));in.seekg(0);
    if(!in.read(reinterpret_cast<char*>(b->data.data()),length))throw Error("collision file read failed");return b;
}
struct Quaternion{double x=0,y=0,z=0,w=1;};
inline Quaternion normalized(Quaternion q){
    double n=std::sqrt(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w);
    if(!std::isfinite(n)||std::abs(n-1)>.01)throw Error("invalid placement quaternion");
    return {q.x/n,q.y/n,q.z/n,q.w/n};
}
inline Vec rotate(Quaternion q,Vec v){Vec u{q.x,q.y,q.z};return v+cross(u,cross(u,v)+v*q.w)*2;}
inline bool overlaps(Box a,Box b){for(int i=0;i<3;i++)if(a.hi[i]<b.lo[i]||a.lo[i]>b.hi[i])return false;return true;}
inline Box transformed(Box b,Vec p,Quaternion q){
    Vec first=p+rotate(q,b.lo);Box result{first,first};
    for(int i=1;i<8;i++){Vec v{i&1?b.hi.x:b.lo.x,i&2?b.hi.y:b.lo.y,i&4?b.hi.z:b.lo.z};v=p+rotate(q,v);result=merge(result,{v,v});}return result;
}
struct Record {
    std::shared_ptr<const Bytes> bytes;
    uint16_t id=0;std::string name;int version=0; // 0 = CADB2, 1/2/3 = COL
    std::size_t spheres=0,boxes=0,vertices=0,faces=0;
    uint32_t sphereCount=0,boxCount=0,vertexCount=0,faceCount=0;
    Box bounds{};bool hasGeometry=false;
    Sphere sphere(std::size_t i)const{
        const auto& b=*bytes;std::size_t p=spheres+i*(version?20:16);
        Sphere s; s.centre=b.vec(p+(version==1?4:0));s.radius=b.f32(p+(version==1?0:12));
        if(s.radius<0)throw Error("negative sphere radius");return s;
    }
    Box box(std::size_t i)const{
        const auto& b=*bytes;std::size_t p=boxes+i*(version?28:24);Vec a=b.vec(p),c=b.vec(p+12);
        Box box=version?Box{a,c}:Box{a-c,a+c};
        if(!valid(box))throw Error("invalid collision box");return box;
    }
    Vec vertex(uint32_t i)const{
        if(i>=vertexCount)throw Error("COL face index out of bounds");const auto& b=*bytes;
        if(version==1)return b.vec(vertices+i*12);
        std::size_t p=vertices+i*6;
        auto signed16=[&](std::size_t offset){uint16_t x=b.u16(offset);return (x<32768?int(x):int(x)-65536)/128.;};
        return {signed16(p),signed16(p+2),signed16(p+4)};
    }
    Triangle triangle(std::size_t i)const{
        const auto& b=*bytes;std::size_t p=faces+i*(version==0?36:version==1?16:8);
        if(version==0)return {b.vec(p),b.vec(p+12),b.vec(p+24),0};
        if(version==1)return {vertex(b.u32(p)),vertex(b.u32(p+4)),vertex(b.u32(p+8)),0};
        return {vertex(b.u16(p)),vertex(b.u16(p+2)),vertex(b.u16(p+4)),0};
    }
    void measure(){
        auto include=[&](Box b){bounds=hasGeometry?merge(bounds,b):b;hasGeometry=true;};
        for(uint32_t i=0;i<sphereCount;i++){auto s=sphere(i);if(s.radius>0){Vec h{s.radius,s.radius,s.radius};include({s.centre-h,s.centre+h});}}
        for(uint32_t i=0;i<boxCount;i++)include(box(i));
        for(uint32_t i=0;i<faceCount;i++){auto t=triangle(i);if(norm(cross(t.b-t.a,t.c-t.a))>eps)include(Obstacle::bounds(t));}
    }
};
struct Placement{std::size_t record=0;Vec position;Quaternion rotation;};
struct Geometry {
    std::vector<Triangle> triangles;std::vector<Sphere> spheres;std::vector<SolidBox> boxes;
    std::size_t selected=0,degenerateFaces=0;
    void limit()const{if(triangles.size()>200000||spheres.size()>10000||boxes.size()>20000)throw Error("collision region exceeds primitive budget; reduce coverage");}
};
class Library {
    std::size_t byteCount=0,primitiveCount=0;
    void budget(const Record& r){
        primitiveCount+=r.sphereCount+r.boxCount+r.faceCount;
        if(primitiveCount>4000000||records.size()>=maximumModels)throw Error("collision library budget exceeded");
    }
    static void headerBounds(const Bytes& b,std::size_t p,int version){
        double radius=b.f32(p+(version==1?0:36));Vec centre=b.vec(p+(version==1?4:24));(void)centre;
        Box box{b.vec(p+(version==1?16:0)),b.vec(p+(version==1?28:12))};
        if(radius<0||!valid(box))throw Error("invalid COL bounds header");
    }
public:
    std::vector<Record> records;std::vector<Placement> placements;bool cadb=false;std::size_t duplicateModels=0;
    void col(std::shared_ptr<const Bytes> b){
        if(cadb)throw Error("cannot mix a CADB transaction with COL files");
        if(b->data.empty()||b->data.size()>maximumBytes-byteCount)throw Error("collision byte budget exceeded");byteCount+=b->data.size();
        std::size_t start=0;
        while(start<b->data.size()){
            b->span(start,72,b->data.size());std::string magic(reinterpret_cast<const char*>(b->data.data()+start),4);
            int version=magic=="COLL"?1:magic=="COL2"?2:magic=="COL3"?3:0;
            if(!version)throw Error("unsupported COL signature/version (supports COLL, COL2, COL3)");
            uint32_t size=b->u32(start+4);if(size<64)throw Error("invalid COL chunk size");
            b->span(start+8,size,b->data.size());std::size_t end=start+8+size;
            Record r;r.bytes=b;r.id=b->u16(start+30);r.name=b->text(start+8,22);r.version=version;
            for(const auto& old:records)if(old.name==r.name)throw Error("duplicate COL model name");
            headerBounds(*b,start+32,version);
            std::size_t at=start+72;
            if(version==1){
                auto count=[&](){b->span(at,4,end);auto n=b->u32(at);at+=4;if(n>1000000)throw Error("COL count budget exceeded");return n;};
                auto section=[&](uint32_t count,std::size_t stride){std::size_t offset=at;b->span(at,std::size_t(count)*stride,end);at+=std::size_t(count)*stride;return offset;};
                r.sphereCount=count();r.spheres=section(r.sphereCount,20);
                if(count()!=0)throw Error("COLL suspension/unknown data is unsupported");
                r.boxCount=count();r.boxes=section(r.boxCount,28);r.vertexCount=count();r.vertices=section(r.vertexCount,12);
                r.faceCount=count();r.faces=section(r.faceCount,16);
                if(end-at>15)throw Error("unexpected COLL tail");for(;at<end;at++)if(b->u8(at))throw Error("unexpected COLL tail bytes");
            }else{
                const std::size_t header=version==2?108:120;b->span(start,header,end);
                r.sphereCount=b->u16(at);r.boxCount=b->u16(at+2);r.faceCount=b->u16(at+4);
                if(b->u8(at+6))throw Error("COL suspension lines are unsupported");
                uint32_t flags=b->u32(at+8);if(flags&~31u)throw Error("unknown COL flags");
                std::vector<std::pair<std::size_t,std::size_t>> sections;
                auto offset=[&](std::size_t field){uint32_t off=b->u32(field);if(!off)return std::size_t(0);if(off<header-4||off>size+4)throw Error("COL offset out of range");return start+4+off;};
                auto section=[&](std::size_t pos,std::size_t bytes){if(!bytes)return;if(!pos)throw Error("missing COL section offset");b->span(pos,bytes,end);for(auto prior:sections)if(pos<prior.second&&prior.first<pos+bytes)throw Error("overlapping COL sections");sections.push_back({pos,pos+bytes});};
                r.spheres=offset(at+12);r.boxes=offset(at+16);(void)offset(at+20);r.vertices=offset(at+24);r.faces=offset(at+28);(void)offset(at+32);
                section(r.spheres,r.sphereCount*20);section(r.boxes,r.boxCount*28);section(r.faces,r.faceCount*8);
                for(uint32_t i=0;i<r.faceCount;i++)for(int j=0;j<3;j++)r.vertexCount=std::max(r.vertexCount,uint32_t(b->u16(r.faces+i*8+j*2))+1);
                section(r.vertices,r.vertexCount*6);
                if(flags&8){
                    if(r.faces<start+header+4)throw Error("invalid COL face groups");
                    uint32_t groups=b->u32(r.faces-4);if(groups>r.faceCount||std::size_t(groups)*28>r.faces-start-header-4)throw Error("invalid COL face group count");
                    std::size_t first=r.faces-4-std::size_t(groups)*28;section(first,std::size_t(groups)*28+4);
                    for(uint32_t i=0;i<groups;i++){std::size_t p=first+i*28;if(!valid(Box{b->vec(p),b->vec(p+12)})||b->u16(p+24)>b->u16(p+26)||b->u16(p+26)>=r.faceCount)throw Error("invalid COL face group");}
                }
                if(version==3){
                    uint32_t n=b->u32(at+36);std::size_t vertices=offset(at+40),faces=offset(at+44);section(faces,std::size_t(n)*8);
                    uint32_t vertexCount=0;for(uint32_t i=0;i<n;i++)for(int j=0;j<3;j++)vertexCount=std::max(vertexCount,uint32_t(b->u16(faces+i*8+j*2))+1);
                    section(vertices,vertexCount*6);
                }
            }
            budget(r);r.measure();records.push_back(std::move(r));start=end;
        }
        if(records.empty())throw Error("empty COL library");
    }
    void database(std::shared_ptr<const Bytes> b){
        if(!records.empty()||!placements.empty()||b->data.size()>maximumBytes)throw Error("invalid CADB transaction");
        b->span(0,12,b->data.size());if(std::memcmp(b->data.data(),"cadf",4)!=0)throw Error("invalid CADB magic; expected cadf");
        if(b->u16(4)!=2)throw Error("unsupported CADB version; expected 2");
        uint16_t models=b->u16(6);uint32_t count=b->u32(8);
        if(!models||models>maximumModels||count>maximumPlacements)throw Error("CADB count budget exceeded");
        std::map<uint16_t,std::size_t> index;std::size_t at=12;
        for(uint32_t i=0;i<models;i++){
            b->span(at,8,b->data.size());Record r;r.bytes=b;r.id=b->u16(at);r.sphereCount=b->u16(at+2);r.boxCount=b->u16(at+4);r.faceCount=b->u16(at+6);at+=8;
            auto earlier=index.find(r.id);
            auto section=[&](uint32_t n,std::size_t stride){std::size_t p=at;b->span(at,std::size_t(n)*stride,b->data.size());at+=std::size_t(n)*stride;return p;};
            r.spheres=section(r.sphereCount,16);r.boxes=section(r.boxCount,24);r.faces=section(r.faceCount,36);
            budget(r);
            if(earlier!=index.end()){
                const auto& old=records[earlier->second];
                // The real Wizard output can contain identical definitions.
                // Accept only byte-identical shapes; conflicts remain errors.
                if(old.sphereCount!=r.sphereCount||old.boxCount!=r.boxCount||old.faceCount!=r.faceCount||
                   !std::equal(b->data.begin()+r.spheres,b->data.begin()+at,old.bytes->data.begin()+old.spheres))
                    throw Error("conflicting CADB model id");
                r.bounds=old.bounds;r.hasGeometry=old.hasGeometry;++duplicateModels;
            }else r.measure();
            index[r.id]=records.size(); // Match ColAndreas' last definition lookup.
            records.push_back(std::move(r));
        }
        b->span(at,std::size_t(count)*30,b->data.size());
        if(b->data.size()-at!=std::size_t(count)*30)throw Error("unexpected CADB trailing bytes");
        for(uint32_t i=0;i<count;i++,at+=30){
            auto model=index.find(b->u16(at));if(model==index.end())throw Error("CADB placement has no collision model");
            Placement p;p.record=model->second;p.position=b->vec(at+2);p.rotation=normalized({b->f32(at+14),b->f32(at+18),b->f32(at+22),b->f32(at+26)});placements.push_back(p);
        }
        cadb=true;byteCount=b->data.size();
    }
    void place(const std::string& key,bool byName,Vec position,Quaternion rotation){
        if(cadb||!finite(position)||norm(position)>1000000||placements.size()>=maximumPlacements)throw Error("invalid COL placement");
        std::string normalizedKey=key;for(char& c:normalizedKey)if(c>='A'&&c<='Z')c+=32;
        std::optional<std::size_t> match;
        for(std::size_t i=0;i<records.size();i++)if(byName?records[i].name==normalizedKey:std::to_string(records[i].id)==key){if(match)throw Error("ambiguous COL model id; select by name");match=i;}
        if(!match)throw Error("COL placement model not found");
        placements.push_back({*match,position,normalized(rotation)});
    }
    Geometry bake(Box coverage,const std::vector<std::size_t>* selectedIndices=nullptr)const{
        if(!valid(coverage)||placements.empty())throw Error("missing placements or invalid region");
        Geometry g;
        for(std::size_t cursor=0;cursor<(selectedIndices?selectedIndices->size():placements.size());cursor++){
            std::size_t i=selectedIndices?selectedIndices->at(cursor):cursor;
            const auto& p=placements[i];const auto& r=records.at(p.record);
            if(!r.hasGeometry||!overlaps(transformed(r.bounds,p.position,p.rotation),coverage))continue;
            g.selected++;int id=1000000+int(i);auto point=[&](Vec v){return p.position+rotate(p.rotation,v);};
            for(uint32_t j=0;j<r.faceCount;j++){
                auto t=r.triangle(j);t={point(t.a),point(t.b),point(t.c),id};
                if(norm(cross(t.b-t.a,t.c-t.a))<=eps){g.degenerateFaces++;continue;}
                if(overlaps(Obstacle::bounds(t),coverage))g.triangles.push_back(t);g.limit();
            }
            for(uint32_t j=0;j<r.sphereCount;j++){
                auto s=r.sphere(j);if(s.radius<=0)continue;s.centre=point(s.centre);s.id=id;Vec h{s.radius,s.radius,s.radius};
                if(overlaps({s.centre-h,s.centre+h},coverage))g.spheres.push_back(s);g.limit();
            }
            for(uint32_t j=0;j<r.boxCount;j++){
                Box b=r.box(j);if(!overlaps(transformed(b,p.position,p.rotation),coverage))continue;
                Vec centre=(b.lo+b.hi)*.5,half=(b.hi-b.lo)*.5;
                if(half.x<=eps||half.y<=eps||half.z<=eps){
                    Vec v[8];for(int k=0;k<8;k++)v[k]=point({k&1?b.hi.x:b.lo.x,k&2?b.hi.y:b.lo.y,k&4?b.hi.z:b.lo.z});
                    constexpr int f[12][3]={{0,1,3},{0,3,2},{4,6,7},{4,7,5},{0,4,5},{0,5,1},{2,3,7},{2,7,6},{0,2,6},{0,6,4},{1,5,7},{1,7,3}};
                    for(auto& face:f){Triangle t{v[face[0]],v[face[1]],v[face[2]],id};if(norm(cross(t.b-t.a,t.c-t.a))>eps)g.triangles.push_back(t);}
                }else{
                    SolidBox s;s.centre=point(centre);s.body.half=half;s.id=id;for(int k=0;k<3;k++){Vec axis; if(k==0)axis.x=1;if(k==1)axis.y=1;if(k==2)axis.z=1;s.body.axes[k]=rotate(p.rotation,axis);}g.boxes.push_back(s);
                }
                g.limit();
            }
        }
        return g;
    }
};
}}} // namespace KLRM::Obstacle::Assets
