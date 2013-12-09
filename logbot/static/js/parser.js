function fetchJson(HOST, DIR) {
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function() {
        if (xhr.status == 404) {
            response = "";
        } else if (xhr.readyState == 4) {
            response = xhr.responseText;
        }
    }

    var dateList = Date().toString().split(" ");
    var filename = dateList[1] + "-" + parseInt(dateList[2]) + "-" + dateList[3];
    var url = HOST + DIR + filename + ".json";

    xhr.open("GET", url, false);
    xhr.send();

    if (this.response == "") {
        return "";
    }
    return JSON.parse("[" + this.response.substring(0, this.response.length - 1) + "]");
}


function loadJson() {
    var channel = "nchusg.it";

    var data = fetchJson("http://irc.nchusg.org/logbot", "/static/data/" + channel + "/");
    var dataLen = data.length;

    var dateList = Date().toString().split(" ");
    var filename = dateList[1] + "-" + parseInt(dateList[2]) + "-" + dateList[3];

    document.getElementById("channel").innerHTML = "#" + channel;
    document.getElementById("date").innerHTML = filename;

    logs = document.getElementById('logs');

    if (data == "") {
        logs.innerHTML = "<li class='msg'>No one speaks yet :-)</li>";
        return;
    }

    if (lastLine == dataLen) {
        return;
    }

    ele = ['time', 'name', 'content'];
    for (i = lastLine; i < dataLen; i++) {
        msg = "<li class='msg' id='" + i + "'>";
        for (j = 0; j < 3; j++) {
            msg += "<span class='" + ele[j] + "'>" + data[i][ele[j]] + "</span>";
        }
        msg += "</li>";
        logs.innerHTML += msg;

        lastLine = i + 1;
    }
}

var lastLine = 0;
var timer = setInterval(loadJson, 30 * 1000);
