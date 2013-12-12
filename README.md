### NCHU - IRC Client and logbot

This IRC Client is settled by the environment KiwiIRC, now this is worked on http://irc.nchusg.org .

In rule, we will only setup the discrition and some theme edit, out config is settled up on first commit. 

The environment we have: 

1. NodeJS - the environment of KiwiIRC

2. Nginx - to link between the subdomain and the port, and doing some security for our server.

### Installation

*Note: This requires Node.js to run. Make sure you have installed Node.js first! http://nodejs.org/download/*

1. Download the Kiwi source or clone the git repository:

    `$ git clone https://github.com/prawnsalad/KiwiIRC.git && cd KiwiIRC`

2. Install the dependencies:

    `$ npm install`

3. Copy and edit the configuration file as needed:

    `$ cp config.example.js config.js`

    `$ vim config.js`

4.  Make sure the client code is built:

    `$ ./kiwi build`
    
    **If you do really change the setting or edit the file in folder "client", you should run it again to make sure the file is update.**
    
    Here are the files which will be built, so edit them seems not work.
    
    1.  Built index.html
    2.  Built engine.io.bundle.js
    3.  Built engine.io.bundle.min.js
    4.  Built kiwi.js
    5.  Built kiwi.min.js
    6.  Built translation file de-de.json
    7.  Built translation file es-419.json
    8.  Built translation file fr.json
    9.  Built translation file it.json
    10. Built translation file en-gb.json
    11. Built translation file no.json
    12. Built translation file pt-br.json
    13. Built translation file he.json
    14. Built translation file ru.json
    15. Built translation file ro.json
    16. Built translation file nl.json
    17. Built translation file vi.json
    18. Built translation file tr.json
    19. Built translation file zh-tw.json



### Running
From the source folder: `$ ./kiwi start`

You can also run kiwi in the foreground to see any output by using the `-f` flag. Eg: `$ ./kiwi -f`

Our Setting is let NodeJS listen on 5001 port

Open your new Kiwi instance in your browser. By default: http://localhost:5001/
