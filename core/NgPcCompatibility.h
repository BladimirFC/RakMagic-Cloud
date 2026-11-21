#pragma once
#include <string>

// Passive diagnostic: no launcher authentication announcements or responses.
namespace ngpc {
class Compatibility {
public:
    void reset(bool) {}
    template<class Send, class SendBits>
    void connected(Send, SendBits) {}
    template<class... Args>
    void receive(Args&&...) {}
    std::string json() const {
        return "{\"schema\":1,\"mode\":\"passive-diagnostic\",\"enabled\":false,"
               "\"clientMode\":\"NORMAL\",\"modeAttempted\":false,\"modeQueued\":false,"
               "\"interfaceQueued\":false,\"presenceAttempted\":false,\"presenceQueued\":false,"
               "\"challengesReceived\":0,\"malformedChallenges\":0,\"responsesQueued\":0,"
               "\"sendFailures\":0,\"officialWorkerRunning\":false,\"serverAcceptanceConfirmed\":null}";
    }
};
}
