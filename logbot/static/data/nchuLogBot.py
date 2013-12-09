import socket
import os
import time
import json


class LogBot():
    def __init__(self):
        self.irc = socket.socket()
        self.connected = False
        self.fwd = os.getcwd()

    def connect(self, HOST, PORT, CHANNEL, NICKNAME, IDENTITY, REALNAME):
        while self.connected is False:
            try:
                self.irc.connect((HOST, PORT))
                self.irc.send("NICK {0}\r\n".format(NICKNAME).encode("utf-8"))
                self.irc.send("USER {0} {1} bla: {2}\r\n".format(IDENTITY, HOST, REALNAME).encode('utf-8'))
                self.irc.send("JOIN {0}\r\n".format(CHANNEL).encode("utf-8"))
                connected = True
                return connected
            except socket.error:
                print("Retrying to connect...")
                time.sleep(3)
                continue

    def listen(self):
        self.dateList = time.ctime().split()
        raw_msg = self.irc.recv(4096).decode("utf-8")
        if raw_msg[0:4] == "PING":
            # raw_msg looks like "PING :HELLO_WORLD"
            self.irc.send("PONG {0}\r\n".format(raw_msg.split()[1]).encode("utf-8"))

        if len(raw_msg.split()) > 2 and raw_msg.split()[1] == "PRIVMSG":
            # raw_msg looks like "NICKNAME!~IDENTITY@HOST PRIVMSG #CHA.NNEL :CONTENTS"
            dateList = self.dateList
            nickname = raw_msg.split("!")[0][1:]
            contents = raw_msg.split(" ", 3)[3][1:]

            msg = "{0} {1} {2}".format(dateList[3], nickname, contents)
            return msg
        return ""

    def logDown(self, msg):
        # Write to day-mon-year.log
        os.chdir(self.fwd)

        try:
            os.mkdir("{0}".format(CHANNEL[1:]))
            os.chdir("{0}".format(CHANNEL[1:]))
        except OSError:
            os.chdir("{0}".format(CHANNEL[1:]))

        dateList = self.dateList
        with open("{0}-{1}-{2}.log".format(dateList[1], dateList[2], dateList[4]), "a") as logFile:
            logFile.write(msg)

    def logToJson(self):
        dateList = self.dateList
        filename = "{0}-{1}-{2}".format(dateList[1], dateList[2], dateList[4])

        with open("{0}.log".format(filename), "r") as logFile:
            ele = ['time', 'name', 'content']
            line = logFile.readlines()[-1].split(" ", 2)
            result = {ele[i]: line[i].strip() for i in range(3)}

        jsonFile = open("{0}.json".format(filename), "a")
        jsonData = json.dumps(result, ensure_ascii=False)
        jsonFile.write("{0},".format(jsonData))
        jsonFile.close()


if __name__ == "__main__":
    HOST = "irc.freenode.org"
    PORT = 6667
    CHANNEL = "#nchusg.it"
    NICKNAME = "SG_Bot"
    IDENTITY = "sg_bot"
    REALNAME = "SG BOT"

    # Login to the server
    bot = LogBot()
    connected = bot.connect(HOST, PORT, CHANNEL, NICKNAME, IDENTITY, REALNAME)

    # Read from the channel
    while connected:
            msg = bot.listen()
            if msg != "":
                bot.logDown(msg)
                bot.logToJson()
                print(msg)

            time.sleep(0.01)
