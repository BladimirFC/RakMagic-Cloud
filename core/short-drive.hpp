// GPL-2.0-or-later. Opt-in one-to-five-metre test, not GTA vehicle physics.
namespace shortmap=KLRM::Obstacle;
shortmap::Sensor shortDriveSensor;
shortmap::Scene shortDriveScene;
shortmap::Navigator shortDriveNavigator;
shortmap::GroundSupport shortDriveGround;
shortmap::CurveTrial shortDriveCurve;
bool shortDriveIsCurve=false,shortDriveIsRoute=false;
shortmap::CheckpointRoute checkpointRoute;
std::string shortDrivePhase="idle",shortDriveReason;
std::string shortDriveBlocker="null";
double shortDriveMetres=5;
bool shortDriveIgnoreTraffic=false;
unsigned shortDriveExcluded=0;
double shortDriveLookahead=.5;
auto shortDriveClock=std::chrono::steady_clock::now(),shortDriveLast=shortDriveClock,shortDrivePrepared=shortDriveClock;
double shortDriveNow(){return std::chrono::duration<double>(std::chrono::steady_clock::now()-shortDriveClock).count();}
void shortDriveStop(const char* reason){
    if(shortDrivePhase=="running"||shortDrivePhase=="prepared"){shortDrivePhase="stopped";shortDriveReason=reason;}
    shortDriveNavigator.active=false;shortDriveNavigator.state.speed=shortDriveNavigator.state.acceleration=0;
    shortDriveCurve.stop(reason);checkpointRoute.stop(reason);
}
void shortDriveReset(){shortDriveStop("disconnect");shortDrivePhase="idle";shortDriveReason.clear();shortDriveBlocker="null";shortDriveMetres=5;shortDriveIgnoreTraffic=false;shortDriveExcluded=0;shortDriveLookahead=.5;shortDriveSensor.reset();shortDriveScene=shortmap::Scene{};shortDriveNavigator=shortmap::Navigator{};shortDriveGround=shortmap::GroundSupport{};shortDriveCurve=shortmap::CurveTrial{};shortDriveIsCurve=false;shortDriveIsRoute=false;checkpointRoute=shortmap::CheckpointRoute{};}
uint16_t shortDriveCar();
void shortDriveAdd(int id,int model){shortDriveSensor.add(id,model);if(id==shortDriveCar())shortDriveStop("own-vehicle-stream-changed");}
void shortDriveLocate(int id,const float* p){shortDriveSensor.locate(id,{p[0],p[1],p[2]},shortDriveNow());}
void shortDriveRemove(int id){shortDriveSensor.remove(id);if(id==shortDriveCar())shortDriveStop("own-vehicle-stream-changed");}
void shortDrivePacket(Packet* packet){
    if(!packet->length)return;size_t offset=packet->data[0]==ID_TIMESTAMP?5:0;if(offset>=packet->length)return;
    if(packet->data[offset]==ID_VEHICLE_SYNC||packet->data[offset]==ID_UNOCCUPIED_SYNC)shortDriveSensor.receive(packet->data,packet->length,packet->bitSize,shortDriveNow());
}
uint16_t shortDriveCar(){return diagnosticVehicle?(diagnosticSeat==0?diagnosticVehicle:0):diagnosticLocalVehicle;}
bool shortDriveReady(){
    const auto id=shortDriveCar();if(!id||state!=3||!spawned||clientPaused||dialogId>=0||selectingTextdraws)return false;
    const auto& car=diagnosticCars[id];return car.present&&car.model==560&&car.engineKnown&&car.engine&&std::isfinite(car.hp)&&car.hp>=250&&car.hp<=2000;
}
double shortDriveUnknownHorizon(){
    const auto& n=shortDriveNavigator;
    if(n.state.speed<1e-6&&std::abs(n.state.acceleration)<1e-6)return .5;
    // Find a feasible jerk-limited stop inside the remaining checked segment.
    // Add 0.5 s for packet/controller response. An infeasible stop excludes no
    // uncertain peer by distance, rather than shortening the required horizon.
    for(double d=.05;d<=n.goal-n.state.position+1e-6;d+=.2){
        auto plan=shortmap::planStop(n.state,n.state.position+d,n.limits);
        if(plan)return plan->duration+.5<=10?plan->duration+.5:-1;
    }
    return -1;
}
shortmap::SensorResult shortDriveSense(){
    const auto& n=shortDriveNavigator;
    const double now=shortDriveNow();
    if(shortDriveIgnoreTraffic){
        // Explicit per-trial opt-out: no foreign record, dimensions, motion,
        // freshness or stream lifecycle participates in this static query.
        shortDriveBlocker="null";shortDriveExcluded=0;shortDriveLookahead=0;
        if(!interiorKnown||int(interiorId)!=shortDriveScene.interior)return {shortmap::Quality::Unknown,{},"wrong-interior"};
        shortmap::World world;world.mesh=shortDriveScene.mesh.get();world.coverage=shortDriveScene.coverage;
        world.staticComplete=world.dynamicsComplete=true;
        return world.sense(n.position(),n.direction,std::max(0.,n.goal-n.state.position)+.6,n.body,now);
    }
    shortDriveLookahead=shortDriveUnknownHorizon();
    auto result=shortDriveSensor.sense(shortDriveScene,shortDriveCar(),interiorKnown?int(interiorId):-1,n.position(),n.direction,std::max(0.,n.goal-n.state.position)+.6,n.body,now,shortDriveLookahead);
    shortDriveExcluded=result.excluded;
    shortDriveBlocker="null";
    if(result.peer>0&&result.peer<2000){
        const auto& peer=shortDriveSensor.peers[result.peer];const auto& car=diagnosticCars[result.peer];
        const auto point=peer.received||peer.located?peer.position:shortmap::Vec{car.pos[0],car.pos[1],car.pos[2]};
        shortDriveBlocker="{\"id\":"+std::to_string(result.peer)+",\"model\":"+std::to_string(peer.model)+",\"distance\":"+(peer.received||car.present?std::to_string(shortmap::norm(point-n.position())):"null")+",\"sizeKnown\":"+(shortmap::vehicleModelSize(peer.model)?"true":"false")+",\"received\":"+(peer.received?"true":"false")+",\"frameAgeMs\":"+(peer.received?std::to_string(std::max(0.,now-peer.stamp)*1000):"null")+"}";
    }
    return result;
}
bool shortDrivePrepare(shortmap::Box coverage,double metres=5,bool ignoreTraffic=false){
    if(!std::isfinite(metres)||metres<1||metres>5||std::floor(metres)!=metres)return false;
    shortDriveStop("new-preparation");shortDrivePhase="blocked";shortDriveReason="vehicle-not-ready";
    shortDriveIsRoute=false;shortDriveIsCurve=false;shortDriveCurve=shortmap::CurveTrial{};
    shortDriveMetres=metres;shortDriveIgnoreTraffic=ignoreTraffic;shortDriveExcluded=0;shortDriveLookahead=.5;shortDriveNavigator=shortmap::Navigator{};shortDriveGround=shortmap::GroundSupport{};shortDriveBlocker="null";
    if(!shortDriveReady())return false;
    if(!shortmap::valid(coverage)||coverage.hi.x-coverage.lo.x>100||coverage.hi.y-coverage.lo.y>100||coverage.hi.z-coverage.lo.z>100)return false;
    try{
        auto bytes=shortmap::Assets::file("data/collision/sultan-probe.cadb");if(bytes->data.size()>4u*1024*1024)throw std::runtime_error("region-too-large");
        shortmap::Assets::Library library;library.database(bytes);auto geometry=library.bake(coverage);
        shortDriveScene.coverage=coverage;shortDriveScene.interior=0;
        // All 212 base models have a conservative peer envelope. The driven
        // Sultan keeps the same independently tested approximate body below.
        shortDriveScene.half=shortmap::vehiclePeerEnvelopes();
        const auto& car=diagnosticCars[shortDriveCar()];const double angle=car.angle*3.141592653589793/180.;
        shortmap::Vec start{position[0],position[1],position[2]},direction{-std::sin(angle),std::cos(angle),0};
        shortDriveGround.prepare(geometry.triangles,geometry.spheres,geometry.boxes,coverage,start,direction,metres,shortmap::Body{});
        shortDriveScene.mesh=std::move(shortDriveGround.obstacles);
        if(!shortDriveNavigator.begin(start,shortDriveGround.target,1.,{2.4,1.,.75}))throw std::runtime_error("invalid-segment");
        auto sensed=shortDriveSense();
        if(sensed.quality==shortmap::Quality::Unknown)throw std::runtime_error(sensed.reason);
        if(sensed.hit)throw std::runtime_error(sensed.peer?"vehicle-in-segment":"mapped-obstacle-in-segment");
        shortDrivePhase="prepared";shortDriveReason="manual-start-required";shortDriveNavigator.active=false;shortDrivePrepared=std::chrono::steady_clock::now();return true;
    }catch(const std::exception& e){shortDriveReason=e.what();shortDriveNavigator.active=false;return false;}
}
bool shortDrivePrepareCurve(shortmap::Box coverage,int side){
    if(side!=-1&&side!=1)return false;
    shortDriveStop("new-preparation");shortDrivePhase="blocked";shortDriveReason="vehicle-not-ready";
    shortDriveIsRoute=false;shortDriveIsCurve=true;shortDriveCurve=shortmap::CurveTrial{};shortDriveGround=shortmap::GroundSupport{};
    shortDriveNavigator=shortmap::Navigator{};shortDriveMetres=2;shortDriveIgnoreTraffic=true;shortDriveBlocker="null";
    shortDriveExcluded=0;shortDriveLookahead=0;
    if(!shortDriveReady())return false;
    if(!interiorKnown||interiorId!=0){shortDriveReason="wrong-interior";return false;}
    if(!shortmap::valid(coverage)||coverage.hi.x-coverage.lo.x>100||coverage.hi.y-coverage.lo.y>100||coverage.hi.z-coverage.lo.z>100)return false;
    try{
        auto bytes=shortmap::Assets::file("data/collision/sultan-probe.cadb");if(bytes->data.size()>4u*1024*1024)throw std::runtime_error("region-too-large");
        shortmap::Assets::Library library;library.database(bytes);auto geometry=library.bake(coverage);
        shortDriveCurve.prepare(geometry.triangles,geometry.spheres,geometry.boxes,coverage,{position[0],position[1],position[2]},diagnosticCars[shortDriveCar()].angle,side);
        shortDrivePhase="prepared";shortDriveReason="manual-start-required";shortDrivePrepared=std::chrono::steady_clock::now();return true;
    }catch(const std::exception& e){shortDriveReason=e.what();return false;}
}
void checkpointRouteRemoved(){
    auto& c=diagnosticCheckpoint;
    if(shortDriveIsRoute&&shortDrivePhase=="running"&&shortmap::norm(shortmap::Vec{position[0],position[1],position[2]}-checkpointRoute.goal)<=c.radius+.25){
        checkpointRoute.stop("checkpoint-cleared-near-destination");checkpointRoute.finished=true;shortDrivePhase="finished";shortDriveReason="checkpoint-cleared-near-destination";
    }else shortDriveStop("checkpoint-removed");
}
bool checkpointRouteMatches(){
    auto& c=diagnosticCheckpoint;return c.active&&c.revision==checkpointRoute.revision&&shortmap::norm(shortmap::Vec{c.p[0],c.p[1],c.p[2]}-checkpointRoute.goal)<.01&&std::abs(c.radius-checkpointRoute.radius)<.001;
}
bool checkpointRouteLoad(){
    shortDriveStop("new-preparation");shortDriveIsRoute=true;shortDriveIsCurve=false;shortDriveIgnoreTraffic=true;shortDrivePhase="blocked";shortDriveReason="vehicle-not-ready";
    checkpointRoute=shortmap::CheckpointRoute{};
    if(!shortDriveReady()||!interiorKnown||interiorId!=0)return false;
    try{
        checkpointRoute.load("state/vehicle-route.plan");
        if(!checkpointRouteMatches())throw std::runtime_error("checkpoint-changed");
        if(shortmap::norm(shortmap::Vec{position[0],position[1],position[2]}-checkpointRoute.poses.front().p)>.1)throw std::runtime_error("route-origin-changed");
        shortDrivePhase="prepared";shortDriveReason="manual-start-required";shortDrivePrepared=std::chrono::steady_clock::now();return true;
    }catch(const std::exception& e){shortDriveReason=e.what();return false;}
}
// Build a quaternion from GTA's local right/forward/up basis. A positive
// GTA heading rotates the local Y axis toward -X (same convention as angleQuat).
void checkpointRouteRotation(const shortmap::RoutePose& p){
    auto right=shortmap::unit(shortmap::cross(p.forward,p.up));double m[3][3]={{right.x,p.forward.x,p.up.x},{right.y,p.forward.y,p.up.y},{right.z,p.forward.z,p.up.z}};
    double q[4]{},trace=m[0][0]+m[1][1]+m[2][2];
    if(trace>0){double v=std::sqrt(trace+1)*2;q[0]=v/4;q[1]=(m[2][1]-m[1][2])/v;q[2]=(m[0][2]-m[2][0])/v;q[3]=(m[1][0]-m[0][1])/v;}
    else {int i=m[1][1]>m[0][0]?1:0;if(m[2][2]>m[i][i])i=2;int j=(i+1)%3,k=(i+2)%3;double v=std::sqrt(1+m[i][i]-m[j][j]-m[k][k])*2;q[i+1]=v/4;q[0]=(m[k][j]-m[j][k])/v;q[j+1]=(m[j][i]+m[i][j])/v;q[k+1]=(m[k][i]+m[i][k])/v;}
    rotation[0]=float(q[0]);for(int i=1;i<4;i++)rotation[i]=float(-q[i]);
}
bool shortDriveStart(){
    if(shortDrivePhase!="prepared"||!shortDriveReady()||std::chrono::steady_clock::now()-shortDrivePrepared>std::chrono::seconds(120))return false;
    shortmap::Vec current{position[0],position[1],position[2]};
    if(shortDriveIsRoute){
        if(!checkpointRouteMatches()||shortmap::norm(current-checkpointRoute.poses.front().p)>.1||!checkpointRoute.start())return false;
        shortDrivePhase="running";shortDriveReason="checkpoint-route";shortDriveLast=std::chrono::steady_clock::now();return true;
    }
    if(shortDriveIsCurve){
        if(shortmap::norm(current-shortDriveCurve.origin)>.05||!shortDriveCurve.start())return false;
        shortDrivePhase="running";shortDriveReason="short-manual-curve";shortDriveLast=std::chrono::steady_clock::now();return true;
    }
    if(shortmap::norm(current-shortDriveNavigator.origin)>.05)return false;
    auto sensed=shortDriveSense();if(sensed.quality==shortmap::Quality::Unknown||sensed.hit){shortDrivePhase="blocked";shortDriveReason=sensed.quality==shortmap::Quality::Unknown?sensed.reason:sensed.peer?"vehicle-in-segment":"mapped-obstacle-in-segment";return false;}
    shortDriveNavigator.active=true;shortDrivePhase="running";shortDriveReason="short-manual-test";shortDriveLast=std::chrono::steady_clock::now();return true;
}
void shortDriveStep(float velocity[3]){
    if(shortDriveIsRoute){
        if(shortDrivePhase!="prepared"&&shortDrivePhase!="running")return;
        if(!shortDriveReady()||!interiorKnown||interiorId!=0){shortDriveStop("vehicle-not-ready");return;}
        if(!checkpointRouteMatches()){shortDriveStop("checkpoint-changed");return;}
        if(shortDrivePhase=="prepared")return;
        auto now=std::chrono::steady_clock::now();double dt=std::chrono::duration<double>(now-shortDriveLast).count();shortDriveLast=now;
        checkpointRoute.step(dt);auto p=checkpointRoute.at(checkpointRoute.state.position);
        auto next=std::upper_bound(checkpointRoute.poses.begin(),checkpointRoute.poses.end(),checkpointRoute.state.position,[](double d,const shortmap::RoutePose& pose){return d<pose.distance;});
        if(next==checkpointRoute.poses.end())next=checkpointRoute.poses.end()-1;
        auto previous=next-1;auto direction=shortmap::unit(next->p-previous->p),v=direction*checkpointRoute.state.speed;
        for(int i=0;i<3;i++){position[i]=float(p.p[i]);diagnosticCars[shortDriveCar()].pos[i]=position[i];velocity[i]=float(v[i]/50.);}
        checkpointRouteRotation(p);float yaw=float(std::atan2(-p.forward.x,p.forward.y)*180/shortmap::routePi);if(yaw<0)yaw+=360;diagnosticCars[shortDriveCar()].angle=yaw;
        if(checkpointRoute.finished){shortDrivePhase="finished";shortDriveReason="checkpoint-position-reached";}
        else if(!checkpointRoute.active){shortDrivePhase="stopped";shortDriveReason=checkpointRoute.reason;}
        if(shortDrivePhase!="running")std::fill(velocity,velocity+3,0.f);return;
    }
    if(shortDriveIsCurve){
        if(shortDrivePhase!="prepared"&&shortDrivePhase!="running")return;
        if(!shortDriveReady()||!interiorKnown||interiorId!=0){shortDriveStop("vehicle-not-ready");return;}
        if(shortDrivePhase=="prepared"){if(!shortDriveCurve.clearRemaining())shortDriveStop("mapped-obstacle-in-segment");return;}
        auto now=std::chrono::steady_clock::now();double dt=std::chrono::duration<double>(now-shortDriveLast).count();shortDriveLast=now;
        shortDriveCurve.step(dt);auto p=shortDriveCurve.point(shortDriveCurve.state.position),v=shortDriveCurve.tangent(shortDriveCurve.state.position)*shortDriveCurve.state.speed;
        for(int i=0;i<3;i++){position[i]=float(p[i]);diagnosticCars[shortDriveCar()].pos[i]=position[i];velocity[i]=float(v[i]/50.);}
        const float yaw=float(shortDriveCurve.heading(shortDriveCurve.state.position));diagnosticCars[shortDriveCar()].angle=yaw;angleQuat(yaw,rotation);
        if(shortDriveCurve.finished){shortDrivePhase="finished";shortDriveReason="destination";}
        else if(!shortDriveCurve.active){shortDrivePhase="stopped";shortDriveReason=shortDriveCurve.reason;}
        if(shortDrivePhase!="running")std::fill(velocity,velocity+3,0.f);
        return;
    }
    if(shortDrivePhase=="prepared"){
        if(!shortDriveReady()){shortDriveStop("vehicle-not-ready");return;}
        auto sensed=shortDriveSense();
        if(sensed.quality==shortmap::Quality::Unknown)shortDriveStop(sensed.reason);
        else if(sensed.hit)shortDriveStop(sensed.peer?"vehicle-in-segment":"mapped-obstacle-in-segment");
        return;
    }
    if(shortDrivePhase!="running")return;
    if(!shortDriveReady()){shortDriveStop("vehicle-not-ready");return;}
    auto now=std::chrono::steady_clock::now();double dt=std::chrono::duration<double>(now-shortDriveLast).count();shortDriveLast=now;
    auto sensed=shortDriveSense();shortDriveNavigator.step(dt,sensed);
    const auto& n=shortDriveNavigator;auto point=n.position();
    for(int i=0;i<3;i++){position[i]=float(point[i]);diagnosticCars[shortDriveCar()].pos[i]=position[i];velocity[i]=float(n.direction[i]*n.state.speed/50.);}
    if(n.finished){shortDrivePhase="finished";shortDriveReason="destination";}
    else if(!n.active||n.blocked&&n.state.speed<.0001){shortDrivePhase="stopped";shortDriveReason=n.reason;shortDriveNavigator.active=false;}
    if(shortDrivePhase!="running")std::fill(velocity,velocity+3,0.f);
}
std::string shortDriveJson(){
    if(shortDriveIsRoute){
        const auto& c=checkpointRoute;
        return "{\"kind\":\"checkpoint-route\",\"phase\":"+quote(shortDrivePhase)+",\"reason\":"+quote(shortDriveReason)+",\"metres\":"+std::to_string(c.length())+",\"progress\":"+std::to_string(c.state.position)+",\"speedLimit\":4,\"speed\":"+std::to_string(c.state.speed)+",\"ignoreTraffic\":true,\"checkpointRevision\":"+std::to_string(c.revision)+",\"estimatedSeconds\":"+std::to_string(c.duration())+",\"samples\":"+std::to_string(c.poses.size())+",\"destination\":["+std::to_string(c.goal.x)+","+std::to_string(c.goal.y)+","+std::to_string(c.goal.z)+"],\"baseMapOnly\":true,\"gtaPhysics\":false}";
    }
    if(shortDriveIsCurve){
        const auto& c=shortDriveCurve;auto end=c.point(c.length);
        return "{\"phase\":"+quote(shortDrivePhase)+",\"reason\":"+quote(shortDriveReason)+",\"kind\":\"curve\",\"metres\":2,\"ignoreTraffic\":true,\"speedLimit\":0.65,\"speed\":"+std::to_string(c.state.speed)+",\"progress\":"+std::to_string(c.state.position)+",\"acceleration\":"+std::to_string(c.state.acceleration)+",\"jerk\":"+std::to_string(c.state.jerk)+",\"destination\":["+std::to_string(end.x)+","+std::to_string(end.y)+","+std::to_string(end.z)+"],\"curve\":{\"side\":"+quote(c.side>0?"derecha":"izquierda")+",\"turnDegrees\":15,\"radius\":"+std::to_string(c.radius)+",\"headingStart\":"+std::to_string(c.initialAngle)+",\"headingEnd\":"+std::to_string(c.heading(c.length))+"},\"groundSupport\":{\"ready\":"+(c.ready?"true":"false")+",\"triangles\":"+std::to_string(c.supportTriangles)+",\"rise\":"+std::to_string(end.z-c.origin.z)+",\"clearance\":"+std::to_string(c.clearance)+"},\"blockingVehicle\":null,\"baseMapOnly\":true,\"gtaPhysics\":false}";
    }
    const auto& n=shortDriveNavigator;auto end=n.origin+n.direction*n.goal;
    return "{\"phase\":"+quote(shortDrivePhase)+",\"reason\":"+quote(shortDriveReason)+",\"metres\":"+std::to_string(shortDriveMetres)+",\"ignoreTraffic\":"+(shortDriveIgnoreTraffic?"true":"false")+",\"speedLimit\":1,\"speed\":"+std::to_string(n.state.speed)+",\"progress\":"+std::to_string(n.state.position*std::hypot(n.direction.x,n.direction.y))+",\"acceleration\":"+std::to_string(n.state.acceleration)+",\"jerk\":"+std::to_string(n.state.jerk)+",\"destination\":["+std::to_string(end.x)+","+std::to_string(end.y)+","+std::to_string(end.z)+"],\"peerFrames\":"+std::to_string(shortDriveSensor.accepted)+",\"excludedVehicles\":"+std::to_string(shortDriveExcluded)+",\"unknownHorizonSeconds\":"+std::to_string(shortDriveLookahead)+",\"vehicleModels\":212,\"blockingVehicle\":"+shortDriveBlocker+",\"groundSupport\":{\"ready\":"+(shortDriveGround.ready?"true":"false")+",\"triangles\":"+std::to_string(shortDriveGround.supportTriangles)+",\"rise\":"+std::to_string(shortDriveGround.rise)+",\"clearance\":"+std::to_string(shortDriveGround.clearance)+"},\"baseMapOnly\":true,\"gtaPhysics\":false}";
}
