(function (global, undefined) {

// Holds anything kiwi client specific (ie. front, gateway, _kiwi.plugs..)
/**
*   @namespace
*/
var _kiwi = {};

_kiwi.model = {};
_kiwi.view = {};
_kiwi.applets = {};


/**
 * A global container for third party access
 * Will be used to access a limited subset of kiwi functionality
 * and data (think: plugins)
 */
_kiwi.global = {
    settings: undefined, // Instance of _kiwi.model.DataStore
    plugins: undefined,
    utils: undefined, // TODO: Re-usable methods
    user: undefined, // TODO: Limited user methods
    server: undefined, // TODO: Limited server methods

    // TODO: think of a better term for this as it will also refer to queries
    channels: undefined, // TODO: Limited access to panels list

    // Event managers for plugins
    components: {
        EventComponent: function(event_source, proxy_event_name) {
            function proxyEvent(event_name, event_data) {
                if (proxy_event_name !== 'all') {
                    event_data = event_name.event_data;
                    event_name = event_name.event_name
                }
//console.log(proxy_event_name, event_name, event_data);
                this.trigger(event_name, event_data);
            }

            // The event we are to proxy
            proxy_event_name = proxy_event_name || 'all';


            _.extend(this, Backbone.Events);
            this._source = event_source;

            // Proxy the events to this dispatcher
            event_source.on(proxy_event_name, proxyEvent, this);

            // Clean up this object
            this.dispose = function () {
                event_source.off(proxy_event_name, proxyEvent);
                this.off();
                delete this.event_source;
            };
        },

        Network: function(connection_id) {
            var connection_event;

            if (typeof connection_id !== 'undefined') {
                connection_event = 'connection:' + connection_id.toString();
            }

            var obj = new this.EventComponent(_kiwi.gateway, connection_event);
            var funcs = {
                kiwi: 'kiwi', raw: 'raw', kick: 'kick', topic: 'topic',
                part: 'part', join: 'join', action: 'action', ctcp: 'ctcp',
                notice: 'notice', msg: 'privmsg', changeNick: 'changeNick'
            };

            // Proxy each gateway method
            _.each(funcs, function(gateway_fn, func_name) {
                obj[func_name] = function() {
                    var fn_name = gateway_fn;

                    // Add connection_id to the argument list
                    var args = Array.prototype.slice.call(arguments, 0);
                    args.unshift(connection_id);

                    // Call the gateway function on behalf of this connection
                    return _kiwi.gateway[fn_name].apply(_kiwi.gateway, args);
                };
            });

            return obj;
        },

        ControlInput: function() {
            var obj = new this.EventComponent(_kiwi.app.controlbox);
            var funcs = {
                processInput: 'run', addPluginIcon: 'addPluginIcon'
            };

            _.each(funcs, function(controlbox_fn, func_name) {
                obj[func_name] = function() {
                    var fn_name = controlbox_fn;
                    return _kiwi.app.controlbox[fn_name].apply(_kiwi.app.controlbox, arguments);
                };
            });

            return obj;
        }
    },

    // Entry point to start the kiwi application
    start: function (opts, callback) {
        var continueStart, locale;
        opts = opts || {};

        continueStart = function (locale, s, xhr) {
            if (locale) {
                _kiwi.global.i18n = new Jed({locale_data: locale, domain: xhr.getResponseHeader('Content-Language')});
            } else {
                _kiwi.global.i18n = new Jed();
            }

            _kiwi.app = new _kiwi.model.Application(opts);

            if (opts.kiwi_server) {
                _kiwi.app.kiwi_server = opts.kiwi_server;
            }

            // Start the client up
            _kiwi.app.start();

            // Now everything has started up, load the plugin manager for third party plugins
            _kiwi.global.plugins = new _kiwi.model.PluginManager();

            callback && callback();
        };

        // Set up the settings datastore
        _kiwi.global.settings = _kiwi.model.DataStore.instance('kiwi.settings');
        _kiwi.global.settings.load();

        // Set the window title
        window.document.title = opts.server_settings.client.window_title || 'NCHU IRC Client';

        locale = _kiwi.global.settings.get('locale');
        if (!locale) {
            $.getJSON(opts.base_path + '/assets/locales/magic.json', continueStart);
        } else {
            $.getJSON(opts.base_path + '/assets/locales/' + locale + '.json', continueStart);
        }
    }
};



// If within a closure, expose the kiwi globals
if (typeof global !== 'undefined') {
    global.kiwi = _kiwi.global;
} else {
    // Not within a closure so set a var in the current scope
    var kiwi = _kiwi.global;
}



_kiwi.model.Application = function () {
    // Set to a reference to this object within initialize()
    var that = null;


    var model = function () {
        /** _kiwi.view.Application */
        this.view = null;

        /** _kiwi.view.StatusMessage */
        this.message = null;

        /* Address for the kiwi server */
        this.kiwi_server = null;

        this.initialize = function (options) {
            that = this;

            if (options[0].container) {
                this.set('container', options[0].container);
            }

            // The base url to the kiwi server
            this.set('base_path', options[0].base_path ? options[0].base_path : '/kiwi');

            // Path for the settings.json file
            this.set('settings_path', options[0].settings_path ?
                    options[0].settings_path :
                    this.get('base_path') + '/assets/settings.json'
            );

            // Any options sent down from the server
            this.server_settings = options[0].server_settings || {};
            this.translations = options[0].translations || {};

            // Best guess at where the kiwi server is
            this.detectKiwiServer();

            // Set any default settings before anything else is applied
            if (this.server_settings && this.server_settings.client && this.server_settings.client.settings) {
                this.applyDefaultClientSettings(this.server_settings.client.settings);
            }
        };


        this.start = function () {
            // Set the gateway up
            _kiwi.gateway = new _kiwi.model.Gateway();
            this.bindGatewayCommands(_kiwi.gateway);

            this.initializeClient();
            this.initializeGlobals();

            this.view.barsHide(true);

            this.showIntialConenctionDialog();
        };


        this.detectKiwiServer = function () {
            // If running from file, default to localhost:7777 by default
            if (window.location.protocol === 'file:') {
                this.kiwi_server = 'http://localhost:7778';
            } else {
                // Assume the kiwi server is on the same server
                this.kiwi_server = window.location.protocol + '//' + window.location.host;
            }
        };


        this.showIntialConenctionDialog = function() {
            var connection_dialog = new _kiwi.model.NewConnection();
            this.populateDefaultServerSettings(connection_dialog);

            connection_dialog.view.$el.addClass('initial');
            this.view.$el.find('.panel_container:first').append(connection_dialog.view.$el);

            var $info = $($('#tmpl_new_connection_info').html().trim());

            if ($info.html()) {
                connection_dialog.view.infoBoxSet($info);
                connection_dialog.view.infoBoxShow();
            }

            // TODO: Shouldn't really be here but it's not working in the view.. :/
            // Hack for firefox browers: Focus is not given on this event loop iteration
            setTimeout(function(){
                connection_dialog.view.$el.find('.nick').select();
            }, 0);

            // Once connected, close this dialog and remove its own event
            var fn = function() {
                connection_dialog.view.$el.slideUp(function() {
                    connection_dialog.view.dispose();
                    connection_dialog = null;

                    _kiwi.gateway.off('onconnect', fn);
                });

            };
            _kiwi.gateway.on('onconnect', fn);
        };


        this.initializeClient = function () {
            this.view = new _kiwi.view.Application({model: this, el: this.get('container')});

            // Takes instances of model_network
            this.connections = new _kiwi.model.NetworkPanelList();

            // Applets panel list
            this.applet_panels = new _kiwi.model.PanelList();
            this.applet_panels.view.$el.addClass('panellist applets');
            this.view.$el.find('.tabs').append(this.applet_panels.view.$el);

            /**
             * Set the UI components up
             */
            this.controlbox = new _kiwi.view.ControlBox({el: $('#kiwi .controlbox')[0]});
            this.bindControllboxCommands(this.controlbox);

            this.topicbar = new _kiwi.view.TopicBar({el: this.view.$el.find('.topic')[0]});

            new _kiwi.view.AppToolbar({el: _kiwi.app.view.$el.find('.toolbar .app_tools')[0]});

            this.message = new _kiwi.view.StatusMessage({el: this.view.$el.find('.status_message')[0]});

            this.resize_handle = new _kiwi.view.ResizeHandler({el: this.view.$el.find('.memberlists_resize_handle')[0]});

            // Rejigg the UI sizes
            this.view.doLayout();
        };


        this.initializeGlobals = function () {
            _kiwi.global.connections = this.connections;

            _kiwi.global.panels = this.panels;
            _kiwi.global.panels.applets = this.applet_panels;

            _kiwi.global.components.Applet = _kiwi.model.Applet;
            _kiwi.global.components.Panel =_kiwi.model.Panel;
        };


        this.applyDefaultClientSettings = function (settings) {
            _.each(settings, function (value, setting) {
                if (typeof _kiwi.global.settings.get(setting) === 'undefined') {
                    _kiwi.global.settings.set(setting, value);
                }
            });
        };


        this.populateDefaultServerSettings = function (new_connection_dialog) {
            var parts;
            var defaults = {
                nick: '',
                server: '',
                port: 6667,
                ssl: false,
                channel: '#chat',
                channel_key: ''
            };
            var uricheck;


            /**
             * Get any settings set by the server
             * These settings may be changed in the server selection dialog or via URL parameters
             */
            if (this.server_settings.client) {
                if (this.server_settings.client.nick)
                    defaults.nick = this.server_settings.client.nick;

                if (this.server_settings.client.server)
                    defaults.server = this.server_settings.client.server;

                if (this.server_settings.client.port)
                    defaults.port = this.server_settings.client.port;

                if (this.server_settings.client.ssl)
                    defaults.ssl = this.server_settings.client.ssl;

                if (this.server_settings.client.channel)
                    defaults.channel = this.server_settings.client.channel;

                if (this.server_settings.client.channel_key)
                    defaults.channel_key = this.server_settings.client.channel_key;
            }



            /**
             * Get any settings passed in the URL
             * These settings may be changed in the server selection dialog
             */

            // Any query parameters first
            if (getQueryVariable('nick'))
                defaults.nick = getQueryVariable('nick');

            if (window.location.hash)
                defaults.channel = window.location.hash;


            // Process the URL part by part, extracting as we go
            parts = window.location.pathname.toString().replace(this.get('base_path'), '').split('/');

            if (parts.length > 0) {
                parts.shift();

                if (parts.length > 0 && parts[0]) {
                    // Check to see if we're dealing with an irc: uri, or whether we need to extract the server/channel info from the HTTP URL path.
                    uricheck = parts[0].substr(0, 7).toLowerCase();
                    if ((uricheck === 'ircs%3a') || (uricheck.substr(0,6) === 'irc%3a')) {
                        parts[0] = decodeURIComponent(parts[0]);
                        // irc[s]://<host>[:<port>]/[<channel>[?<password>]]
                        uricheck = /^irc(s)?:(?:\/\/?)?([^:\/]+)(?::([0-9]+))?(?:(?:\/)([^\?]*)(?:(?:\?)(.*))?)?$/.exec(parts[0]);
                        /*
                            uricheck[1] = ssl (optional)
                            uricheck[2] = host
                            uricheck[3] = port (optional)
                            uricheck[4] = channel (optional)
                            uricheck[5] = channel key (optional, channel must also be set)
                        */
                        if (uricheck) {
                            if (typeof uricheck[1] !== 'undefined') {
                                defaults.ssl = true;
                                if (defaults.port === 6667) {
                                    defaults.port = 6697;
                                }
                            }
                            defaults.server = uricheck[2];
                            if (typeof uricheck[3] !== 'undefined') {
                                defaults.port = uricheck[3];
                            }
                            if (typeof uricheck[4] !== 'undefined') {
                                defaults.channel = '#' + uricheck[4];
                                if (typeof uricheck[5] !== 'undefined') {
                                    defaults.channel_key = uricheck[5];
                                }
                            }
                        }
                        parts = [];
                    } else {
                        // Extract the port+ssl if we find one
                        if (parts[0].search(/:/) > 0) {
                            defaults.port = parts[0].substring(parts[0].search(/:/) + 1);
                            defaults.server = parts[0].substring(0, parts[0].search(/:/));
                            if (defaults.port[0] === '+') {
                                defaults.port = parseInt(defaults.port.substring(1), 10);
                                defaults.ssl = true;
                            } else {
                                defaults.ssl = false;
                            }

                        } else {
                            defaults.server = parts[0];
                        }

                        parts.shift();
                    }
                }

                if (parts.length > 0 && parts[0]) {
                    defaults.channel = '#' + parts[0];
                    parts.shift();
                }
            }

            // If any settings have been given by the server.. override any auto detected settings
            /**
             * Get any server restrictions as set in the server config
             * These settings can not be changed in the server selection dialog
             */
            if (this.server_settings && this.server_settings.connection) {
                if (this.server_settings.connection.server) {
                    defaults.server = this.server_settings.connection.server;
                }

                if (this.server_settings.connection.port) {
                    defaults.port = this.server_settings.connection.port;
                }

                if (this.server_settings.connection.ssl) {
                    defaults.ssl = this.server_settings.connection.ssl;
                }

                if (this.server_settings.connection.channel) {
                    defaults.channel = this.server_settings.connection.channel;
                }

                if (this.server_settings.connection.channel_key) {
                    defaults.channel_key = this.server_settings.connection.channel_key;
                }

                if (this.server_settings.connection.nick) {
                    defaults.nick = this.server_settings.connection.nick;
                }
            }

            // Set any random numbers if needed
            defaults.nick = defaults.nick.replace('?', Math.floor(Math.random() * 100000).toString());

            if (getQueryVariable('encoding'))
                defaults.encoding = getQueryVariable('encoding');

            // Populate the server select box with defaults
            new_connection_dialog.view.populateFields(defaults);
        };


        this.panels = (function() {
            var fn = function(panel_type) {
                var panels;

                // Default panel type
                panel_type = panel_type || 'connections';

                switch (panel_type) {
                case 'connections':
                    panels = this.connections.panels();
                    break;
                case 'applets':
                    panels = this.applet_panels.models;
                    break;
                }

                // Active panels / server
                panels.active = this.connections.active_panel;
                panels.server = this.connections.active_connection ?
                    this.connections.active_connection.panels.server :
                    null;

                return panels;
            };

            _.extend(fn, Backbone.Events);

            return fn;
        })();


        this.bindGatewayCommands = function (gw) {
            var that = this;

            gw.on('onconnect', function (event) {
                that.view.barsShow();
            });


            /**
             * Handle the reconnections to the kiwi server
             */
            (function () {
                // 0 = non-reconnecting state. 1 = reconnecting state.
                var gw_stat = 0;

                // If the current or upcoming disconnect was planned
                var unplanned_disconnect = false;

                gw.on('disconnect', function (event) {
                    unplanned_disconnect = !gw.disconnect_requested;

                    if (unplanned_disconnect) {
                        var msg = _kiwi.global.i18n.translate('client_models_application_reconnecting').fetch() + '...';
                        that.message.text(msg, {timeout: 10000});
                    }

                    that.view.$el.removeClass('connected');

                    // Mention the disconnection on every channel
                    _kiwi.app.connections.forEach(function(connection) {
                        connection.panels.server.addMsg('', msg, 'action quit');

                        connection.panels.forEach(function(panel) {
                            if (!panel.isChannel())
                                return;

                            panel.addMsg('', msg, 'action quit');
                        });
                    });

                    gw_stat = 1;
                });


                gw.on('reconnecting', function (event) {
                    var msg = _kiwi.global.i18n.translate('client_models_application_reconnect_in_x_seconds').fetch(event.delay/1000) + '...';

                    // Only need to mention the repeating re-connection messages on server panels
                    _kiwi.app.connections.forEach(function(connection) {
                        connection.panels.server.addMsg('', msg, 'action quit');
                    });
                });


                gw.on('onconnect', function (event) {
                    that.view.$el.addClass('connected');
                    if (gw_stat !== 1) return;

                    if (unplanned_disconnect) {
                        var msg = _kiwi.global.i18n.translate('client_models_application_reconnect_successfully').fetch() + ':)';
                        that.message.text(msg, {timeout: 5000});
                    }

                    // Mention the re-connection on every channel
                    _kiwi.app.connections.forEach(function(connection) {
                        connection.panels.server.addMsg('', msg, 'action join');

                        connection.panels.forEach(function(panel) {
                            if (!panel.isChannel())
                                return;

                            panel.addMsg('', msg, 'action join');
                        });
                    });

                    gw_stat = 0;
                });
            })();


            gw.on('kiwi:reconfig', function () {
                $.getJSON(that.get('settings_path'), function (data) {
                    that.server_settings = data.server_settings || {};
                    that.translations = data.translations || {};
                });
            });


            gw.on('kiwi:jumpserver', function (data) {
                var serv;
                // No server set? Then nowhere to jump to.
                if (typeof data.kiwi_server === 'undefined')
                    return;

                serv = data.kiwi_server;

                // Strip any trailing slash from the end
                if (serv[serv.length-1] === '/')
                    serv = serv.substring(0, serv.length-1);

                _kiwi.app.kiwi_server = serv;

                // Force the jumpserver now?
                if (data.force) {
                    // Get an interval between 5 and 6 minutes so everyone doesn't reconnect it all at once
                    var jump_server_interval = Math.random() * (360 - 300) + 300;

                    // Tell the user we are going to disconnect, wait 5 minutes then do the actual reconnect
                    var msg = _kiwi.global.i18n.translate('client_models_application_jumpserver_prepare').fetch();
                    that.message.text(msg, {timeout: 10000});

                    setTimeout(function forcedReconnect() {
                        var msg = _kiwi.global.i18n.translate('client_models_application_jumpserver_reconnect').fetch();
                        that.message.text(msg, {timeout: 8000});

                        setTimeout(function forcedReconnectPartTwo() {
                            _kiwi.gateway.reconnect(function() {
                                // Reconnect all the IRC connections
                                that.connections.forEach(function(con){ con.reconnect(); });
                            });
                        }, 5000);

                    }, jump_server_interval * 1000);
                }
            });
        };



        /**
         * Bind to certain commands that may be typed into the control box
         */
        this.bindControllboxCommands = function (controlbox) {
            // Default aliases
            $.extend(controlbox.preprocessor.aliases, {
                // General aliases
                '/p': '/part $1+',
                '/me': '/action $1+',
                '/j': '/join $1+',
                '/q': '/query $1+',
                '/w': '/whois $1+',
                '/raw': '/quote $1+',

                // Op related aliases
                '/op': '/quote mode $channel +o $1+',
                '/deop': '/quote mode $channel -o $1+',
                '/hop': '/quote mode $channel +h $1+',
                '/dehop': '/quote mode $channel -h $1+',
                '/voice': '/quote mode $channel +v $1+',
                '/devoice': '/quote mode $channel -v $1+',
                '/k': '/kick $channel $1+',

                // Misc aliases
                '/slap': '/me slaps $1 around a bit with a large trout'
            });

            controlbox.on('unknown_command', unknownCommand);

            controlbox.on('command', allCommands);
            controlbox.on('command:msg', msgCommand);

            controlbox.on('command:action', actionCommand);

            controlbox.on('command:join', joinCommand);

            controlbox.on('command:part', partCommand);

            controlbox.on('command:nick', function (ev) {
                _kiwi.gateway.changeNick(null, ev.params[0]);
            });

            controlbox.on('command:query', queryCommand);

            controlbox.on('command:invite', inviteCommand);

            controlbox.on('command:topic', topicCommand);

            controlbox.on('command:notice', noticeCommand);

            controlbox.on('command:quote', quoteCommand);

            controlbox.on('command:kick', kickCommand);

            controlbox.on('command:clear', clearCommand);

            controlbox.on('command:ctcp', ctcpCommand);

            controlbox.on('command:server', serverCommand);

            controlbox.on('command:whois', whoisCommand);

            controlbox.on('command:whowas', whowasCommand);

            controlbox.on('command:encoding', encodingCommand);

            controlbox.on('command:css', function (ev) {
                var queryString = '?reload=' + new Date().getTime();
                $('link[rel="stylesheet"]').each(function () {
                    this.href = this.href.replace(/\?.*|$/, queryString);
                });
            });

            controlbox.on('command:js', function (ev) {
                if (!ev.params[0]) return;
                $script(ev.params[0] + '?' + (new Date().getTime()));
            });


            controlbox.on('command:set', function (ev) {
                if (!ev.params[0]) return;

                var setting = ev.params[0],
                    value;

                // Do we have a second param to set a value?
                if (ev.params[1]) {
                    ev.params.shift();

                    value = ev.params.join(' ');

                    // If we're setting a true boolean value..
                    if (value === 'true')
                        value = true;

                    // If we're setting a false boolean value..
                    if (value === 'false')
                        value = false;

                    // If we're setting a number..
                    if (parseInt(value, 10).toString() === value)
                        value = parseInt(value, 10);

                    _kiwi.global.settings.set(setting, value);
                }

                // Read the value to the user
                _kiwi.app.panels().active.addMsg('', setting + ' = ' + _kiwi.global.settings.get(setting).toString());
            });


            controlbox.on('command:save', function (ev) {
                _kiwi.global.settings.save();
                _kiwi.app.panels().active.addMsg('', _kiwi.global.i18n.translate('client_models_application_settings_saved').fetch());
            });


            controlbox.on('command:alias', function (ev) {
                var name, rule;

                // No parameters passed so list them
                if (!ev.params[1]) {
                    $.each(controlbox.preprocessor.aliases, function (name, rule) {
                        _kiwi.app.panels().server.addMsg(' ', name + '   =>   ' + rule);
                    });
                    return;
                }

                // Deleting an alias?
                if (ev.params[0] === 'del' || ev.params[0] === 'delete') {
                    name = ev.params[1];
                    if (name[0] !== '/') name = '/' + name;
                    delete controlbox.preprocessor.aliases[name];
                    return;
                }

                // Add the alias
                name = ev.params[0];
                ev.params.shift();
                rule = ev.params.join(' ');

                // Make sure the name starts with a slash
                if (name[0] !== '/') name = '/' + name;

                // Now actually add the alias
                controlbox.preprocessor.aliases[name] = rule;
            });


            controlbox.on('command:ignore', function (ev) {
                var list = _kiwi.gateway.get('ignore_list');

                // No parameters passed so list them
                if (!ev.params[0]) {
                    if (list.length > 0) {
                        _kiwi.app.panels().active.addMsg(' ', _kiwi.global.i18n.translate('client_models_application_ignore_title').fetch() + ':');
                        $.each(list, function (idx, ignored_pattern) {
                            _kiwi.app.panels().active.addMsg(' ', ignored_pattern);
                        });
                    } else {
                        _kiwi.app.panels().active.addMsg(' ', _kiwi.global.i18n.translate('client_models_application_ignore_none').fetch());
                    }
                    return;
                }

                // We have a parameter, so add it
                list.push(ev.params[0]);
                _kiwi.gateway.set('ignore_list', list);
                _kiwi.app.panels().active.addMsg(' ', _kiwi.global.i18n.translate('client_models_application_ignore_nick').fetch(ev.params[0]));
            });


            controlbox.on('command:unignore', function (ev) {
                var list = _kiwi.gateway.get('ignore_list');

                if (!ev.params[0]) {
                    _kiwi.app.panels().active.addMsg(' ', _kiwi.global.i18n.translate('client_models_application_ignore_stop_notice').fetch());
                    return;
                }

                list = _.reject(list, function(pattern) {
                    return pattern === ev.params[0];
                });

                _kiwi.gateway.set('ignore_list', list);

                _kiwi.app.panels().active.addMsg(' ', _kiwi.global.i18n.translate('client_models_application_ignore_stopped').fetch(ev.params[0]));
            });


            controlbox.on('command:applet', appletCommand);
            controlbox.on('command:settings', settingsCommand);
            controlbox.on('command:script', scriptCommand);
        };

        // A fallback action. Send a raw command to the server
        function unknownCommand (ev) {
            var raw_cmd = ev.command + ' ' + ev.params.join(' ');
            console.log('RAW: ' + raw_cmd);
            _kiwi.gateway.raw(null, raw_cmd);
        }

        function allCommands (ev) {}

        function joinCommand (ev) {
            var panels, channel_names;

            channel_names = ev.params.join(' ').split(',');
            panels = that.connections.active_connection.createAndJoinChannels(channel_names);

            // Show the last channel if we have one
            if (panels.length)
                panels[panels.length - 1].view.show();
        }

        function queryCommand (ev) {
            var destination, message, panel;

            destination = ev.params[0];
            ev.params.shift();

            message = ev.params.join(' ');

            // Check if we have the panel already. If not, create it
            panel = that.connections.active_connection.panels.getByName(destination);
            if (!panel) {
                panel = new _kiwi.model.Query({name: destination});
                that.connections.active_connection.panels.add(panel);
            }

            if (panel) panel.view.show();

            if (message) {
                that.connections.active_connection.gateway.msg(panel.get('name'), message);
                panel.addMsg(_kiwi.app.connections.active_connection.get('nick'), message);
            }

        }

        function msgCommand (ev) {
            var message,
                destination = ev.params[0],
                panel = that.connections.active_connection.panels.getByName(destination) || that.panels().server;

            ev.params.shift();
            message = formatToIrcMsg(ev.params.join(' '));

            panel.addMsg(_kiwi.app.connections.active_connection.get('nick'), message);
            _kiwi.gateway.privmsg(null, destination, message);
        }

        function actionCommand (ev) {
            if (_kiwi.app.panels().active.isServer()) {
                return;
            }

            var panel = _kiwi.app.panels().active;
            panel.addMsg('', '* ' + _kiwi.app.connections.active_connection.get('nick') + ' ' + ev.params.join(' '), 'action');
            _kiwi.gateway.action(null, panel.get('name'), ev.params.join(' '));
        }

        function partCommand (ev) {
            if (ev.params.length === 0) {
                _kiwi.gateway.part(null, _kiwi.app.panels().active.get('name'));
            } else {
                _.each(ev.params, function (channel) {
                    _kiwi.gateway.part(null, channel);
                });
            }
        }

        function topicCommand (ev) {
            var channel_name;

            if (ev.params.length === 0) return;

            if (that.isChannelName(ev.params[0])) {
                channel_name = ev.params[0];
                ev.params.shift();
            } else {
                channel_name = _kiwi.app.panels().active.get('name');
            }

            _kiwi.gateway.topic(null, channel_name, ev.params.join(' '));
        }

        function noticeCommand (ev) {
            var destination;

            // Make sure we have a destination and some sort of message
            if (ev.params.length <= 1) return;

            destination = ev.params[0];
            ev.params.shift();

            _kiwi.gateway.notice(null, destination, ev.params.join(' '));
        }

        function quoteCommand (ev) {
            var raw = ev.params.join(' ');
            _kiwi.gateway.raw(null, raw);
        }

        function kickCommand (ev) {
            var nick, panel = _kiwi.app.panels().active;

            if (!panel.isChannel()) return;

            // Make sure we have a nick
            if (ev.params.length === 0) return;

            nick = ev.params[0];
            ev.params.shift();

            _kiwi.gateway.kick(null, panel.get('name'), nick, ev.params.join(' '));
        }

        function clearCommand (ev) {
            // Can't clear a server or applet panel
            if (_kiwi.app.panels().active.isServer() || _kiwi.app.panels().active.isApplet()) {
                return;
            }

            if (_kiwi.app.panels().active.clearMessages) {
                _kiwi.app.panels().active.clearMessages();
            }
        }

        function ctcpCommand(ev) {
            var target, type;

            // Make sure we have a target and a ctcp type (eg. version, time)
            if (ev.params.length < 2) return;

            target = ev.params[0];
            ev.params.shift();

            type = ev.params[0];
            ev.params.shift();

            _kiwi.gateway.ctcp(null, true, type, target, ev.params.join(' '));
        }

        function settingsCommand (ev) {
            var settings = _kiwi.model.Applet.loadOnce('kiwi_settings');
            settings.view.show();
        }

        function scriptCommand (ev) {
            var editor = _kiwi.model.Applet.loadOnce('kiwi_script_editor');
            editor.view.show();
        }

        function appletCommand (ev) {
            if (!ev.params[0]) return;

            var panel = new _kiwi.model.Applet();

            if (ev.params[1]) {
                // Url and name given
                panel.load(ev.params[0], ev.params[1]);
            } else {
                // Load a pre-loaded applet
                if (_kiwi.applets[ev.params[0]]) {
                    panel.load(new _kiwi.applets[ev.params[0]]());
                } else {
                    _kiwi.app.panels().server.addMsg('', _kiwi.global.i18n.translate('client_models_application_applet_notfound').fetch(ev.params[0]));
                    return;
                }
            }

            _kiwi.app.connections.active_connection.panels.add(panel);
            panel.view.show();
        }



        function inviteCommand (ev) {
            var nick, channel;

            // A nick must be specified
            if (!ev.params[0])
                return;

            // Can only invite into channels
            if (!_kiwi.app.panels().active.isChannel())
                return;

            nick = ev.params[0];
            channel = _kiwi.app.panels().active.get('name');

            _kiwi.app.connections.active_connection.gateway.raw('INVITE ' + nick + ' ' + channel);

            _kiwi.app.panels().active.addMsg('', '== ' + nick + ' has been invited to ' + channel, 'action');
        }


        function whoisCommand (ev) {
            var nick;

            if (ev.params[0]) {
                nick = ev.params[0];
            } else if (_kiwi.app.panels().active.isQuery()) {
                nick = _kiwi.app.panels().active.get('name');
            }

            if (nick)
                _kiwi.app.connections.active_connection.gateway.raw('WHOIS ' + nick + ' ' + nick);
        }


        function whowasCommand (ev) {
            var nick;

            if (ev.params[0]) {
                nick = ev.params[0];
            } else if (_kiwi.app.panels().active.isQuery()) {
                nick = _kiwi.app.panels().active.get('name');
            }

            if (nick)
                _kiwi.app.connections.active_connection.gateway.raw('WHOWAS ' + nick);
        }

        function encodingCommand (ev) {
            if (ev.params[0]) {
                _kiwi.gateway.setEncoding(null, ev.params[0], function (success) {
                    if (success) {
                        _kiwi.app.panels().active.addMsg('', _kiwi.global.i18n.translate('client_models_application_encoding_changed').fetch(ev.params[0]));
                    } else {
                        _kiwi.app.panels().active.addMsg('', _kiwi.global.i18n.translate('client_models_application_encoding_invalid').fetch(ev.params[0]));
                    }
                });
            } else {
                _kiwi.app.panels().active.addMsg('', _kiwi.global.i18n.translate('client_models_application_encoding_notspecified').fetch());
                _kiwi.app.panels().active.addMsg('', _kiwi.global.i18n.translate('client_models_application_encoding_usage').fetch());
            }
        }

        function serverCommand (ev) {
            var server, port, ssl, password, nick,
                tmp;

            // If no server address given, show the new connection dialog
            if (!ev.params[0]) {
                tmp = new _kiwi.view.MenuBox(_kiwi.global.i18n.translate('client_models_application_connection_create').fetch());
                tmp.addItem('new_connection', new _kiwi.model.NewConnection().view.$el);
                tmp.show();

                // Center screen the dialog
                tmp.$el.offset({
                    top: (that.view.$el.height() / 2) - (tmp.$el.height() / 2),
                    left: (that.view.$el.width() / 2) - (tmp.$el.width() / 2)
                });

                return;
            }

            // Port given in 'host:port' format and no specific port given after a space
            if (ev.params[0].indexOf(':') > 0) {
                tmp = ev.params[0].split(':');
                server = tmp[0];
                port = tmp[1];

                password = ev.params[1] || undefined;

            } else {
                // Server + port given as 'host port'
                server = ev.params[0];
                port = ev.params[1] || 6667;

                password = ev.params[2] || undefined;
            }

            // + in the port means SSL
            if (port.toString()[0] === '+') {
                ssl = true;
                port = parseInt(port.substring(1), 10);
            } else {
                ssl = false;
            }

            // Default port if one wasn't found
            port = port || 6667;

            // Use the same nick as we currently have
            nick = _kiwi.app.connections.active_connection.get('nick');

            _kiwi.app.panels().active.addMsg('', _kiwi.global.i18n.translate('client_models_application_connection_connecting').fetch(server, port.toString()));

            _kiwi.gateway.newConnection({
                nick: nick,
                host: server,
                port: port,
                ssl: ssl,
                password: password
            }, function(err, new_connection) {
                if (err)
                    _kiwi.app.panels().active.addMsg('', _kiwi.global.i18n.translate('client_models_application_connection_error').fetch(server, port.toString(), err.toString()));
            });
        }





        this.isChannelName = function (channel_name) {
            var channel_prefix = _kiwi.gateway.get('channel_prefix');

            if (!channel_name || !channel_name.length) return false;
            return (channel_prefix.indexOf(channel_name[0]) > -1);
        };


    };


    model = Backbone.Model.extend(new model());

    return new model(arguments);
};



_kiwi.model.Gateway = function () {

    // Set to a reference to this object within initialize()
    var that = null;

    this.defaults = {
        /**
        *   The name of the network
        *   @type    String
        */
        name: 'Server',

        /**
        *   The address (URL) of the network
        *   @type    String
        */
        address: '',

        /**
        *   The current nickname
        *   @type   String
        */
        nick: '',

        /**
        *   The channel prefix for this network
        *   @type    String
        */
        channel_prefix: '#',

        /**
        *   The user prefixes for channel owner/admin/op/voice etc. on this network
        *   @type   Array
        */
        user_prefixes: ['~', '&', '@', '+'],

        /**
        *   The URL to the Kiwi server
        *   @type   String
        */
        kiwi_server: '//kiwi',

        /**
        *   List of nicks we are ignoring
        *   @type Array
        */
        ignore_list: []
    };


    this.initialize = function () {
        that = this;

        // For ease of access. The socket.io object
        this.socket = this.get('socket');

        this.applyEventHandlers();

        // Used to check if a disconnection was unplanned
        this.disconnect_requested = false;
    };


    this.applyEventHandlers = function () {
        /*
        kiwi.gateway.on('message:#channel', my_function);
        kiwi.gateway.on('message:somenick', my_function);

        kiwi.gateway.on('notice:#channel', my_function);
        kiwi.gateway.on('action:somenick', my_function);

        kiwi.gateway.on('join:#channel', my_function);
        kiwi.gateway.on('part:#channel', my_function);
        kiwi.gateway.on('quit', my_function);
        */
        var that = this;

        // Some easier handler events
        this.on('onmsg', function (event) {
            var source,
                connection = _kiwi.app.connections.getByConnectionId(event.server),
                is_pm = (event.channel.toLowerCase() == connection.get('nick').toLowerCase());

            source = is_pm ? event.nick : event.channel;

            that.trigger('message:' + source, event);
            that.trigger('message', event);

            if (is_pm) {
                that.trigger('pm:' + source, event);
                that.trigger('pm', event);
            }
        }, this);


        this.on('onnotice', function (event) {
            // The notice towards a channel or a query window?
            var source = event.target || event.nick;

            this.trigger('notice:' + source, event);
            this.trigger('notice', event);
        }, this);


        this.on('onaction', function (event) {
            var source,
                connection = _kiwi.app.connections.getByConnectionId(event.server),
                is_pm = (event.channel.toLowerCase() == connection.get('nick').toLowerCase());

            source = is_pm ? event.nick : event.channel;

            that.trigger('action:' + source, event);

            if (is_pm) {
                that.trigger('action:' + source, event);
                that.trigger('action', event);
            }
        }, this);


        this.on('ontopic', function (event) {
            that.trigger('topic:' + event.channel, event);
            that.trigger('topic', event);
        });


        this.on('onjoin', function (event) {
            that.trigger('join:' + event.channel, event);
            that.trigger('join', event);
        });

    };



    this.reconnect = function (callback) {
        var that = this,
            transport_path;

        this.disconnect_requested = true;
        this.socket.close();

        this.socket = null;
        this.connect(callback);
    };



    /**
    *   Connects to the server
    *   @param  {Function}  callback    A callback function to be invoked once Kiwi's server has connected to the IRC server
    */
    this.connect = function (callback) {
        this.socket = new EngineioTools.ReconnectingSocket(this.get('kiwi_server'), {
            path: _kiwi.app.get('base_path') + '/transport',
            reconnect_max_attempts: 5,
            reconnect_delay: 2000
        });

        this.rpc = new EngineioTools.Rpc(this.socket);

        this.socket.on('connect_failed', function (reason) {
            this.socket.disconnect();
            this.trigger("connect_fail", {reason: reason});
        });

        this.socket.on('error', function (e) {
            console.log("_kiwi.gateway.socket.on('error')", {reason: e});
            that.trigger("connect_fail", {reason: e});
        });

        this.socket.on('connecting', function (transport_type) {
            console.log("_kiwi.gateway.socket.on('connecting')");
            that.trigger("connecting");
        });

        /**
         * Once connected to the kiwi server send the IRC connect command along
         * with the IRC server details.
         * A `connect` event is sent from the kiwi server once connected to the
         * IRCD and the nick has been accepted.
         */
        this.socket.on('open', function () {
            // Reset the disconnect_requested flag
            that.disconnect_requested = false;

            console.log("_kiwi.gateway.socket.on('open')");

            callback && callback();
        });

        this.rpc.on('too_many_connections', function () {
            that.trigger("connect_fail", {reason: 'too_many_connections'});
        });

        this.rpc.on('irc', function (response, data) {
            that.parse(data.command, data.data);
        });

        this.rpc.on('kiwi', function (response, data) {
            that.parseKiwi(data.command, data.data);
        });

        this.socket.on('close', function () {
            that.trigger("disconnect", {});
            console.log("_kiwi.gateway.socket.on('close')");
        });

        this.socket.on('reconnecting', function (status) {
            console.log("_kiwi.gateway.socket.on('reconnecting')");
            that.trigger("reconnecting", {delay: status.delay, attempts: status.attempts});
        });

        this.socket.on('reconnecting_failed', function () {
            console.log("_kiwi.gateway.socket.on('reconnect_failed')");
        });
    };


    /**
     * Return a new network object with the new connection details
     */
    this.newConnection = function(connection_info, callback_fn) {
        var that = this;

        this.makeIrcConnection(connection_info, function(err, server_num) {
            var connection;

            if (!err) {
                if (!_kiwi.app.connections.getByConnectionId(server_num)){
                    var inf = {
                        connection_id: server_num,
                        nick: connection_info.nick,
                        address: connection_info.host,
                        port: connection_info.port,
                        ssl: connection_info.ssl,
                        password: connection_info.password
                    };
                    connection = new _kiwi.model.Network(inf);
                    _kiwi.app.connections.add(connection);
                }

                console.log("_kiwi.gateway.socket.on('connect')", connection);
                callback_fn && callback_fn(err, connection);

            } else {
                console.log("_kiwi.gateway.socket.on('error')", {reason: err});
                callback_fn && callback_fn(err);
            }
        });
    };


    /**
     * Make a new IRC connection and return its connection ID
     */
    this.makeIrcConnection = function(connection_info, callback_fn) {
        var server_info = {
            command:    'connect',
            nick:       connection_info.nick,
            hostname:   connection_info.host,
            port:       connection_info.port,
            ssl:        connection_info.ssl,
            password:   connection_info.password
        };

        connection_info.options = connection_info.options || {};

        // A few optional parameters
        if (connection_info.options.encoding)
            server_info.encoding = connection_info.options.encoding;

        this.rpc.call('kiwi', server_info, function (err, server_num) {
            if (!err) {
                callback_fn && callback_fn(err, server_num);

            } else {
                callback_fn && callback_fn(err);
            }
        });
    };


    this.isConnected = function () {
        // TODO: Check this. Might want to use .readyState
        return this.socket;
    };



    this.parseKiwi = function (command, data) {
        this.trigger('kiwi:' + command, data);
        this.trigger('kiwi', data);
    };
    /*
        Events:
            msg
            action
            server_connect
            options
            motd
            notice
            userlist
            nick
            join
            topic
            part
            kick
            quit
            whois
            syncchannel_redirect
            debug
    */
    /**
    *   Parses the response from the server
    */
    this.parse = function (command, data) {
        //console.log('gateway event', command, data);

        if (command !== undefined) {
            switch (command) {
            case 'options':
                $.each(data.options, function (name, value) {
                    switch (name) {
                    case 'CHANTYPES':
                        that.set('channel_prefix', value.join(''));
                        break;
                    case 'NETWORK':
                        that.set('name', value);
                        break;
                    case 'PREFIX':
                        that.set('user_prefixes', value);
                        break;
                    }
                });
                that.set('cap', data.cap);
                break;

            /*
            case 'sync':
                if (_kiwi.gateway.onSync && _kiwi.gateway.syncing) {
                    _kiwi.gateway.syncing = false;
                    _kiwi.gateway.onSync(item);
                }
                break;
            */

            case 'kiwi':
                this.emit('_kiwi.' + data.namespace, data.data);
                break;
            }
        }


        if (typeof data.server !== 'undefined') {
            that.trigger('connection:' + data.server.toString(), {
                event_name: command,
                event_data: data
            });
        }

        // Trigger the global events (Mainly legacy now)
        that.trigger('on' + command, data);
    };

    /**
    *   Sends data to the server
    *   @private
    *   @param  {Object}    data        The data to send
    *   @param  {Function}  callback    A callback function
    */
    this.sendData = function (connection_id, data, callback) {
        if (typeof connection_id === 'undefined' || connection_id === null)
            connection_id = _kiwi.app.connections.active_connection.get('connection_id');

        var data_buffer = {
            server: connection_id,
            data: JSON.stringify(data)
        };
        this.rpc.call('irc', data_buffer, callback);
    };

    /**
    *   Sends a PRIVMSG message
    *   @param  {String}    target      The target of the message (e.g. a channel or nick)
    *   @param  {String}    msg         The message to send
    *   @param  {Function}  callback    A callback function
    */
    this.privmsg = function (connection_id, target, msg, callback) {
        var data = {
            method: 'privmsg',
            args: {
                target: target,
                msg: msg
            }
        };

        this.sendData(connection_id, data, callback);
    };

    /**
    *   Sends a NOTICE message
    *   @param  {String}    target      The target of the message (e.g. a channel or nick)
    *   @param  {String}    msg         The message to send
    *   @param  {Function}  callback    A callback function
    */
    this.notice = function (connection_id, target, msg, callback) {
        var data = {
            method: 'notice',
            args: {
                target: target,
                msg: msg
            }
        };

        this.sendData(connection_id, data, callback);
    };

    /**
    *   Sends a CTCP message
    *   @param  {Boolean}   request     Indicates whether this is a CTCP request (true) or reply (false)
    *   @param  {String}    type        The type of CTCP message, e.g. 'VERSION', 'TIME', 'PING' etc.
    *   @param  {String}    target      The target of the message, e.g a channel or nick
    *   @param  {String}    params      Additional paramaters
    *   @param  {Function}  callback    A callback function
    */
    this.ctcp = function (connection_id, request, type, target, params, callback) {
        var data = {
            method: 'ctcp',
            args: {
                request: request,
                type: type,
                target: target,
                params: params
            }
        };

        this.sendData(connection_id, data, callback);
    };

    /**
    *   @param  {String}    target      The target of the message (e.g. a channel or nick)
    *   @param  {String}    msg         The message to send
    *   @param  {Function}  callback    A callback function
    */
    this.action = function (connection_id, target, msg, callback) {
        this.ctcp(connection_id, true, 'ACTION', target, msg, callback);
    };

    /**
    *   Joins a channel
    *   @param  {String}    channel     The channel to join
    *   @param  {String}    key         The key to the channel
    *   @param  {Function}  callback    A callback function
    */
    this.join = function (connection_id, channel, key, callback) {
        var data = {
            method: 'join',
            args: {
                channel: channel,
                key: key
            }
        };

        this.sendData(connection_id, data, callback);
    };

    /**
    *   Leaves a channel
    *   @param  {String}    channel     The channel to part
    *   @param  {Function}  callback    A callback function
    */
    this.part = function (connection_id, channel, callback) {
        var data = {
            method: 'part',
            args: {
                channel: channel
            }
        };

        this.sendData(connection_id, data, callback);
    };

    /**
    *   Queries or modifies a channell topic
    *   @param  {String}    channel     The channel to query or modify
    *   @param  {String}    new_topic   The new topic to set
    *   @param  {Function}  callback    A callback function
    */
    this.topic = function (connection_id, channel, new_topic, callback) {
        var data = {
            method: 'topic',
            args: {
                channel: channel,
                topic: new_topic
            }
        };

        this.sendData(connection_id, data, callback);
    };

    /**
    *   Kicks a user from a channel
    *   @param  {String}    channel     The channel to kick the user from
    *   @param  {String}    nick        The nick of the user to kick
    *   @param  {String}    reason      The reason for kicking the user
    *   @param  {Function}  callback    A callback function
    */
    this.kick = function (connection_id, channel, nick, reason, callback) {
        var data = {
            method: 'kick',
            args: {
                channel: channel,
                nick: nick,
                reason: reason
            }
        };

        this.sendData(connection_id, data, callback);
    };

    /**
    *   Disconnects us from the server
    *   @param  {String}    msg         The quit message to send to the IRC server
    *   @param  {Function}   callback    A callback function
    */
    this.quit = function (connection_id, msg, callback) {
        msg = msg || "";
        var data = {
            method: 'quit',
            args: {
                message: msg
            }
        };

        this.sendData(connection_id, data, callback);
    };

    /**
    *   Sends a string unmodified to the IRC server
    *   @param  {String}    data        The data to send to the IRC server
    *   @param  {Function}  callback    A callback function
    */
    this.raw = function (connection_id, data, callback) {
        data = {
            method: 'raw',
            args: {
                data: data
            }
        };

        this.sendData(connection_id, data, callback);
    };

    /**
    *   Changes our nickname
    *   @param  {String}    new_nick    Our new nickname
    *   @param  {Function}  callback    A callback function
    */
    this.changeNick = function (connection_id, new_nick, callback) {
        var data = {
            method: 'nick',
            args: {
                nick: new_nick
            }
        };

        this.sendData(connection_id, data, callback);
    };

    /**
     *  Sends ENCODING change request to server.
     *  @param  {String}     new_encoding  The new proposed encode
     *  @param  {Fucntion}   callback      A callback function
     */
    this.setEncoding = function (connection_id, new_encoding, callback) {
        var data = {
            method: 'encoding',
            args: {
                encoding: new_encoding
            }
        };
        this.sendData(connection_id, data, callback);
    };

    /**
    *   Sends data to a fellow Kiwi IRC user
    *   @param  {String}    target      The nick of the Kiwi IRC user to send to
    *   @param  {String}    data        The data to send
    *   @param  {Function}  callback    A callback function
    */
    this.kiwi = function (target, data, callback) {
        data = {
            method: 'kiwi',
            args: {
                target: target,
                data: data
            }
        };

        this.sendData(data, callback);
    };

    // Check a nick alongside our ignore list
    this.isNickIgnored = function (nick) {
        var idx, list = this.get('ignore_list');
        var pattern, regex;

        for (idx = 0; idx < list.length; idx++) {
            pattern = list[idx].replace(/([.+^$[\]\\(){}|-])/g, "\\$1")
                .replace('*', '.*')
                .replace('?', '.');

            regex = new RegExp(pattern, 'i');
            if (regex.test(nick)) return true;
        }

        return false;
    };


    return new (Backbone.Model.extend(this))(arguments);
};



(function () {

    _kiwi.model.Network = Backbone.Model.extend({
        defaults: {
            connection_id: 0,
            /**
            *   The name of the network
            *   @type    String
            */
            name: 'Network',

            /**
            *   The address (URL) of the network
            *   @type    String
            */
            address: '',

            /**
            *   The port for the network
            *   @type    Int
            */
            port: 6667,

            /**
            *   If this network uses SSL
            *   @type    Bool
            */
            ssl: false,

            /**
            *   The password to connect to this network
            *   @type    String
            */
            password: '',

            /**
            *   The current nickname
            *   @type   String
            */
            nick: '',

            /**
            *   The channel prefix for this network
            *   @type    String
            */
            channel_prefix: '#',

            /**
            *   The user prefixes for channel owner/admin/op/voice etc. on this network
            *   @type   Array
            */
            user_prefixes: ['~', '&', '@', '+']
        },


        initialize: function () {
            // If we already have a connection, bind our events
            if (typeof this.get('connection_id') !== 'undefined') {
                this.gateway = _kiwi.global.components.Network(this.get('connection_id'));
                this.bindGatewayEvents();
            }

            // Create our panel list (tabs)
            this.panels = new _kiwi.model.PanelList([], this);
            //this.panels.network = this;

            // Automatically create a server tab
            var server_panel = new _kiwi.model.Server({name: 'Server'});
            this.panels.add(server_panel);
            this.panels.server = this.panels.active = server_panel;
        },


        reconnect: function(callback_fn) {
            var that = this,
                server_info = {
                    nick:       this.get('nick'),
                    host:   this.get('address'),
                    port:       this.get('port'),
                    ssl:        this.get('ssl'),
                    password:   this.get('password')
                };

            _kiwi.gateway.makeIrcConnection(server_info, function(err, connection_id) {
                if (!err) {
                    that.gateway.dispose();

                    that.set('connection_id', connection_id);
                    that.gateway = _kiwi.global.components.Network(that.get('connection_id'));
                    that.bindGatewayEvents();

                    callback_fn && callback_fn(err);

                } else {
                    console.log("_kiwi.gateway.socket.on('error')", {reason: err});
                    callback_fn && callback_fn(err);
                }
            });
        },


        bindGatewayEvents: function () {
            //this.gateway.on('all', function() {console.log('ALL', this.get('connection_id'), arguments);});

            this.gateway.on('connect', onConnect, this);
            this.gateway.on('disconnect', onDisconnect, this);

            this.gateway.on('nick', function(event) {
                if (event.nick === this.get('nick')) {
                    this.set('nick', event.newnick);
                }
            }, this);

            this.gateway.on('options', onOptions, this);
            this.gateway.on('motd', onMotd, this);
            this.gateway.on('join', onJoin, this);
            this.gateway.on('part', onPart, this);
            this.gateway.on('quit', onQuit, this);
            this.gateway.on('kick', onKick, this);
            this.gateway.on('msg', onMsg, this);
            this.gateway.on('nick', onNick, this);
            this.gateway.on('ctcp_request', onCtcpRequest, this);
            this.gateway.on('ctcp_response', onCtcpResponse, this);
            this.gateway.on('notice', onNotice, this);
            this.gateway.on('action', onAction, this);
            this.gateway.on('topic', onTopic, this);
            this.gateway.on('topicsetby', onTopicSetBy, this);
            this.gateway.on('userlist', onUserlist, this);
            this.gateway.on('userlist_end', onUserlistEnd, this);
            this.gateway.on('mode', onMode, this);
            this.gateway.on('whois', onWhois, this);
            this.gateway.on('whowas', onWhowas, this);
            this.gateway.on('away', onAway, this);
            this.gateway.on('list_start', onListStart, this);
            this.gateway.on('irc_error', onIrcError, this);
            this.gateway.on('unknown_command', onUnknownCommand, this);
        },


        /**
         * Create panels and join the channel
         * This will not wait for the join event to create a panel. This
         * increases responsiveness in case of network lag
         */
        createAndJoinChannels: function (channels) {
            var that = this,
                panels = [];

            // Multiple channels may come as comma-delimited
            if (typeof channels === 'string') {
                channels = channels.split(',');
            }

            $.each(channels, function (index, channel_name_key) {
                // We may have a channel key so split it off
                var spli = channel_name_key.trim().split(' '),
                    channel_name = spli[0],
                    channel_key = spli[1] || '';

                // Trim any whitespace off the name
                channel_name = channel_name.trim();

                // If not a valid channel name, display a warning
                if (!_kiwi.app.isChannelName(channel_name)) {
                    that.panels.server.addMsg('', _kiwi.global.i18n.translate('client_models_network_channel_invalid_name').fetch(channel_name));
                    _kiwi.app.message.text(_kiwi.global.i18n.translate('client_models_network_channel_invalid_name').fetch(channel_name), {timeout: 5000});
                    return;
                }

                // Check if we have the panel already. If not, create it
                channel = that.panels.getByName(channel_name);
                if (!channel) {
                    channel = new _kiwi.model.Channel({name: channel_name});
                    that.panels.add(channel);
                }

                panels.push(channel);

                that.gateway.join(channel_name, channel_key);
            });

            return panels;
        },


        /**
         * Join all the open channels we have open
         * Reconnecting to a network would typically call this.
         */
        rejoinAllChannels: function() {
            var that = this;

            this.panels.forEach(function(panel) {
                if (!panel.isChannel())
                    return;

                that.gateway.join(panel.get('name'));
            });
        }
    });



    function onDisconnect(event) {
        $.each(this.panels.models, function (index, panel) {
            panel.addMsg('', _kiwi.global.i18n.translate('client_models_network_disconnected').fetch(), 'action quit');
        });
    }



    function onConnect(event) {
        var panels, channel_names;

        // Update our nick with what the network gave us
        this.set('nick', event.nick);

        // If this is a re-connection then we may have some channels to re-join
        this.rejoinAllChannels();

        // Auto joining channels
        if (this.auto_join && this.auto_join.channel) {
            panels = this.createAndJoinChannels(this.auto_join.channel + ' ' + (this.auto_join.key || ''));

            // Show the last channel if we have one
            if (panels)
                panels[panels.length - 1].view.show();

            delete this.auto_join;
        }
    }



    function onOptions(event) {
        var that = this;

        $.each(event.options, function (name, value) {
            switch (name) {
            case 'CHANTYPES':
                that.set('channel_prefix', value.join(''));
                break;
            case 'NETWORK':
                that.set('name', value);
                break;
            case 'PREFIX':
                that.set('user_prefixes', value);
                break;
            }
        });

        this.set('cap', event.cap);
    }



    function onMotd(event) {
        this.panels.server.addMsg(this.get('name'), event.msg, 'motd');
    }



    function onJoin(event) {
        var c, members, user;
        c = this.panels.getByName(event.channel);
        if (!c) {
            c = new _kiwi.model.Channel({name: event.channel});
            this.panels.add(c);
        }

        members = c.get('members');
        if (!members) return;

        user = new _kiwi.model.Member({nick: event.nick, ident: event.ident, hostname: event.hostname});
        members.add(user, {kiwi: event});
    }



    function onPart(event) {
        var channel, members, user,
            part_options = {};

        part_options.type = 'part';
        part_options.message = event.message || '';
        part_options.time = event.time;

        channel = this.panels.getByName(event.channel);
        if (!channel) return;

        // If this is us, close the panel
        if (event.nick === this.get('nick')) {
            channel.close();
            return;
        }

        members = channel.get('members');
        if (!members) return;

        user = members.getByNick(event.nick);
        if (!user) return;

        members.remove(user, {kiwi: part_options});
    }



    function onQuit(event) {
        var member, members,
            quit_options = {};

        quit_options.type = 'quit';
        quit_options.message = event.message || '';
        quit_options.time = event.time;

        $.each(this.panels.models, function (index, panel) {
            if (!panel.isChannel()) return;

            member = panel.get('members').getByNick(event.nick);
            if (member) {
                panel.get('members').remove(member, {kiwi: quit_options});
            }
        });
    }



    function onKick(event) {
        var channel, members, user,
            part_options = {};

        part_options.type = 'kick';
        part_options.by = event.nick;
        part_options.message = event.message || '';
        part_options.current_user_kicked = (event.kicked == this.get('nick'));
        part_options.current_user_initiated = (event.nick == this.get('nick'));
        part_options.time = event.time;

        channel = this.panels.getByName(event.channel);
        if (!channel) return;

        members = channel.get('members');
        if (!members) return;

        user = members.getByNick(event.kicked);
        if (!user) return;


        members.remove(user, {kiwi: part_options});

        if (part_options.current_user_kicked) {
            members.reset([]);
        }
    }



    function onMsg(event) {
        var panel,
            is_pm = (event.channel.toLowerCase() == this.get('nick').toLowerCase());

        // An ignored user? don't do anything with it
        if (_kiwi.gateway.isNickIgnored(event.nick)) {
            return;
        }

        if (is_pm) {
            // If a panel isn't found for this PM, create one
            panel = this.panels.getByName(event.nick);
            if (!panel) {
                panel = new _kiwi.model.Query({name: event.nick});
                this.panels.add(panel);
            }

        } else {
            // If a panel isn't found for this channel, reroute to the
            // server panel
            panel = this.panels.getByName(event.channel);
            if (!panel) {
                panel = this.panels.server;
            }
        }

        panel.addMsg(event.nick, event.msg, 'privmsg', {time: event.time});
    }



    function onNick(event) {
        var member;

        $.each(this.panels.models, function (index, panel) {
            if (panel.get('name') == event.nick)
                panel.set('name', event.newnick);

            if (!panel.isChannel()) return;

            member = panel.get('members').getByNick(event.nick);
            if (member) {
                member.set('nick', event.newnick);
                panel.addMsg('', '== ' + _kiwi.global.i18n.translate('client_models_network_nickname_changed').fetch(event.nick, event.newnick) , 'action nick', {time: event.time});
            }
        });
    }



    function onCtcpRequest(event) {
        // An ignored user? don't do anything with it
        if (_kiwi.gateway.isNickIgnored(event.nick)) {
            return;
        }

        // Reply to a TIME ctcp
        if (event.msg.toUpperCase() === 'TIME') {
            this.gateway.ctcp(false, event.type, event.nick, (new Date()).toString());
        }
    }



    function onCtcpResponse(event) {
        // An ignored user? don't do anything with it
        if (_kiwi.gateway.isNickIgnored(event.nick)) {
            return;
        }

        this.panels.server.addMsg('[' + event.nick + ']', 'CTCP ' + event.msg, 'ctcp', {time: event.time});
    }



    function onNotice(event) {
        var panel, channel_name;

        // An ignored user? don't do anything with it
        if (!event.from_server && event.nick && _kiwi.gateway.isNickIgnored(event.nick)) {
            return;
        }

        // Find a panel for the destination(channel) or who its from
        if (!event.from_server) {
            panel = this.panels.getByName(event.target) || this.panels.getByName(event.nick);

            // Forward ChanServ messages to its associated channel
            if (event.nick && event.nick.toLowerCase() == 'chanserv' && event.msg.charAt(0) == '[') {
                channel_name = /\[([^ \]]+)\]/gi.exec(event.msg);
                if (channel_name && channel_name[1]) {
                    channel_name = channel_name[1];

                    panel = this.panels.getByName(channel_name);
                }
            }

            if (!panel) {
                panel = this.panels.server;
            }
        } else {
            panel = this.panels.server;
        }

        panel.addMsg('[' + (event.nick||'') + ']', event.msg, 'notice', {time: event.time});

        // Show this notice to the active panel if it didn't have a set target
        if (!event.from_server && panel === this.panels.server && _kiwi.app.panels().active !== this.panels.server)
            _kiwi.app.panels().active.addMsg('[' + (event.nick||'') + ']', event.msg, 'notice', {time: event.time});
    }



    function onAction(event) {
        var panel,
            is_pm = (event.channel.toLowerCase() == this.get('nick').toLowerCase());

        // An ignored user? don't do anything with it
        if (_kiwi.gateway.isNickIgnored(event.nick)) {
            return;
        }

        if (is_pm) {
            // If a panel isn't found for this PM, create one
            panel = this.panels.getByName(event.nick);
            if (!panel) {
                panel = new _kiwi.model.Channel({name: event.nick});
                this.panels.add(panel);
            }

        } else {
            // If a panel isn't found for this channel, reroute to the
            // server panel
            panel = this.panels.getByName(event.channel);
            if (!panel) {
                panel = this.panels.server;
            }
        }

        panel.addMsg('', '* ' + event.nick + ' ' + event.msg, 'action', {time: event.time});
    }



    function onTopic(event) {
        var c;
        c = this.panels.getByName(event.channel);
        if (!c) return;

        // Set the channels topic
        c.set('topic', event.topic);

        // If this is the active channel, update the topic bar too
        if (c.get('name') === this.panels.active.get('name')) {
            _kiwi.app.topicbar.setCurrentTopic(event.topic);
        }
    }



    function onTopicSetBy(event) {
        var c, when;
        c = this.panels.getByName(event.channel);
        if (!c) return;

        when = formatDate(new Date(event.when * 1000));
        c.addMsg('', _kiwi.global.i18n.translate('client_models_network_topic').fetch(event.nick, when), 'topic');
    }



    function onUserlist(event) {
        var channel;
        channel = this.panels.getByName(event.channel);

        // If we didn't find a channel for this, may aswell leave
        if (!channel) return;

        channel.temp_userlist = channel.temp_userlist || [];
        _.each(event.users, function (item) {
            var user = new _kiwi.model.Member({nick: item.nick, modes: item.modes});
            channel.temp_userlist.push(user);
        });
    }



    function onUserlistEnd(event) {
        var channel;
        channel = this.panels.getByName(event.channel);

        // If we didn't find a channel for this, may aswell leave
        if (!channel) return;

        // Update the members list with the new list
        channel.get('members').reset(channel.temp_userlist || []);

        // Clear the temporary userlist
        delete channel.temp_userlist;
    }



    function onMode(event) {
        var channel, i, prefixes, members, member, find_prefix;

        // Build a nicely formatted string to be displayed to a regular human
        function friendlyModeString (event_modes, alt_target) {
            var modes = {}, return_string;

            // If no default given, use the main event info
            if (!event_modes) {
                event_modes = event.modes;
                alt_target = event.target;
            }

            // Reformat the mode object to make it easier to work with
            _.each(event_modes, function (mode){
                var param = mode.param || alt_target || '';

                // Make sure we have some modes for this param
                if (!modes[param]) {
                    modes[param] = {'+':'', '-':''};
                }

                modes[param][mode.mode[0]] += mode.mode.substr(1);
            });

            // Put the string together from each mode
            return_string = [];
            _.each(modes, function (modeset, param) {
                var str = '';
                if (modeset['+']) str += '+' + modeset['+'];
                if (modeset['-']) str += '-' + modeset['-'];
                return_string.push(str + ' ' + param);
            });
            return_string = return_string.join(', ');

            return return_string;
        }


        channel = this.panels.getByName(event.target);
        if (channel) {
            prefixes = this.get('user_prefixes');
            find_prefix = function (p) {
                return event.modes[i].mode[1] === p.mode;
            };
            for (i = 0; i < event.modes.length; i++) {
                if (_.any(prefixes, find_prefix)) {
                    if (!members) {
                        members = channel.get('members');
                    }
                    member = members.getByNick(event.modes[i].param);
                    if (!member) {
                        console.log('MODE command recieved for unknown member %s on channel %s', event.modes[i].param, event.target);
                        return;
                    } else {
                        if (event.modes[i].mode[0] === '+') {
                            member.addMode(event.modes[i].mode[1]);
                        } else if (event.modes[i].mode[0] === '-') {
                            member.removeMode(event.modes[i].mode[1]);
                        }
                        members.sort();
                        //channel.addMsg('', '== ' + event.nick + ' set mode ' + event.modes[i].mode + ' ' + event.modes[i].param, 'action mode');
                    }
                } else {
                    // Channel mode being set
                    // TODO: Store this somewhere?
                    //channel.addMsg('', 'CHANNEL === ' + event.nick + ' set mode ' + event.modes[i].mode + ' on ' + event.target, 'action mode');
                }
            }

            channel.addMsg('', '== ' + _kiwi.global.i18n.translate('client_models_network_mode').fetch(event.nick, friendlyModeString()), 'action mode', {time: event.time});
        } else {
            // This is probably a mode being set on us.
            if (event.target.toLowerCase() === this.get("nick").toLowerCase()) {
                this.panels.server.addMsg('', '== ' + _kiwi.global.i18n.translate('client_models_network_selfmode').fetch(event.nick, friendlyModeString()), 'action mode');
            } else {
               console.log('MODE command recieved for unknown target %s: ', event.target, event);
            }
        }
    }



    function onWhois(event) {
        var logon_date, idle_time = '', panel;

        if (event.end)
            return;

        if (typeof event.idle !== 'undefined') {
            idle_time = secondsToTime(parseInt(event.idle, 10));
            idle_time = idle_time.h.toString().lpad(2, "0") + ':' + idle_time.m.toString().lpad(2, "0") + ':' + idle_time.s.toString().lpad(2, "0");
        }

        panel = _kiwi.app.panels().active;
        if (event.ident) {
            panel.addMsg(event.nick, event.nick + ' [' + event.nick + '!' + event.ident + '@' + event.host + '] * ' + event.msg, 'whois');
        } else if (event.chans) {
            panel.addMsg(event.nick, _kiwi.global.i18n.translate('client_models_network_channels').fetch(event.chans), 'whois');
        } else if (event.irc_server) {
            panel.addMsg(event.nick, _kiwi.global.i18n.translate('client_models_network_server').fetch(event.irc_server, event.server_info), 'whois');
        } else if (event.msg) {
            panel.addMsg(event.nick, event.msg, 'whois');
        } else if (event.logon) {
            logon_date = new Date();
            logon_date.setTime(event.logon * 1000);
            logon_date = formatDate(logon_date);

            panel.addMsg(event.nick, _kiwi.global.i18n.translate('client_models_network_idle_and_signon').fetch(idle_time, logon_date), 'whois');
        } else if (event.away_reason) {
            panel.addMsg(event.nick, _kiwi.global.i18n.translate('client_models_network_away').fetch(event.away_reason), 'whois');
        } else {
            panel.addMsg(event.nick, _kiwi.global.i18n.translate('client_models_network_idle').fetch(idle_time), 'whois');
        }
    }

    function onWhowas(event) {
        var panel;

        if (event.end)
            return;

        panel = _kiwi.app.panels().active;
        if (event.host) {
            panel.addMsg(event.nick, event.nick + ' [' + event.nick + ((event.ident)? '!' + event.ident : '') + '@' + event.host + '] * ' + event.real_name, 'whois');
        } else {
            panel.addMsg(event.nick, _kiwi.global.i18n.translate('client_models_network_nickname_notfound').fetch(), 'whois');
        }
    }


    function onAway(event) {
        $.each(this.panels.models, function (index, panel) {
            if (!panel.isChannel()) return;

            member = panel.get('members').getByNick(event.nick);
            if (member) {
                member.set('away', !(!event.trailing));
            }
        });
    }



    function onListStart(event) {
        var chanlist = _kiwi.model.Applet.loadOnce('kiwi_chanlist');
        chanlist.view.show();
    }



    function onIrcError(event) {
        var panel, tmp;

        if (event.channel !== undefined && !(panel = this.panels.getByName(event.channel))) {
            panel = this.panels.server;
        }

        switch (event.error) {
        case 'banned_from_channel':
            panel.addMsg(' ', '== ' + _kiwi.global.i18n.translate('client_models_network_banned').fetch(event.channel, event.reason), 'status');
            _kiwi.app.message.text(_kiwi.global.i18n.translate('client_models_network_banned').fetch(event.channel, event.reason));
            break;
        case 'bad_channel_key':
            panel.addMsg(' ', '== ' + _kiwi.global.i18n.translate('client_models_network_channel_badkey').fetch(event.channel), 'status');
            _kiwi.app.message.text(_kiwi.global.i18n.translate('client_models_network_channel_badkey').fetch(event.channel));
            break;
        case 'invite_only_channel':
            panel.addMsg(' ', '== ' + _kiwi.global.i18n.translate('client_models_network_channel_inviteonly').fetch(event.channel), 'status');
            _kiwi.app.message.text(_kiwi.global.i18n.translate('client_models_network_channel_inviteonly').fetch(event.channel));
            break;
        case 'user_on_channel':
            panel.addMsg(' ', '== ' + event.nick + ' is already on this channel');
            break;
        case 'channel_is_full':
            panel.addMsg(' ', '== ' + _kiwi.global.i18n.translate('client_models_network_channel_limitreached').fetch(event.channel), 'status');
            _kiwi.app.message.text(_kiwi.global.i18n.translate('client_models_network_channel_limitreached').fetch(event.channel));
            break;
        case 'chanop_privs_needed':
            panel.addMsg(' ', '== ' + event.reason, 'status');
            _kiwi.app.message.text(event.reason + ' (' + event.channel + ')');
            break;
        case 'no_such_nick':
            tmp = this.panels.getByName(event.nick);
            if (tmp) {
                tmp.addMsg(' ', '== ' + event.nick + ': ' + event.reason, 'status');
            } else {
                this.panels.server.addMsg(' ', '== ' + event.nick + ': ' + event.reason, 'status');
            }
            break;
        case 'nickname_in_use':
            this.panels.server.addMsg(' ', '== ' + _kiwi.global.i18n.translate('client_models_network_nickname_alreadyinuse').fetch( event.nick), 'status');
            if (this.panels.server !== this.panels.active) {
                _kiwi.app.message.text(_kiwi.global.i18n.translate('client_models_network_nickname_alreadyinuse').fetch(event.nick));
            }

            // Only show the nickchange component if the controlbox is open
            if (_kiwi.app.controlbox.$el.css('display') !== 'none') {
                (new _kiwi.view.NickChangeBox()).render();
            }

            break;

        case 'password_mismatch':
            this.panels.server.addMsg(' ', '== ' + _kiwi.global.i18n.translate('client_models_network_badpassword').fetch(), 'status');
            break;
        default:
            // We don't know what data contains, so don't do anything with it.
            //_kiwi.front.tabviews.server.addMsg(null, ' ', '== ' + data, 'status');
        }
    }


    function onUnknownCommand(event) {
        var display_params = _.clone(event.params);

        // A lot of commands have our nick as the first parameter. This is redundant for us
        if (display_params[0] && display_params[0] == this.get('nick')) {
            display_params.shift();
        }

        if (event.trailing)
            display_params.push(event.trailing);

        this.panels.server.addMsg('', '[' + event.command + '] ' + display_params.join(', ', ''));
    }
}

)();



_kiwi.model.Member = Backbone.Model.extend({
    sortModes: function (modes) {
        return modes.sort(function (a, b) {
            var a_idx, b_idx, i;
            var user_prefixes = _kiwi.gateway.get('user_prefixes');

            for (i = 0; i < user_prefixes.length; i++) {
                if (user_prefixes[i].mode === a) {
                    a_idx = i;
                }
            }
            for (i = 0; i < user_prefixes.length; i++) {
                if (user_prefixes[i].mode === b) {
                    b_idx = i;
                }
            }
            if (a_idx < b_idx) {
                return -1;
            } else if (a_idx > b_idx) {
                return 1;
            } else {
                return 0;
            }
        });
    },
    initialize: function (attributes) {
        var nick, modes, prefix;
        nick = this.stripPrefix(this.get("nick"));

        modes = this.get("modes");
        modes = modes || [];
        this.sortModes(modes);
        this.set({"nick": nick, "modes": modes, "prefix": this.getPrefix(modes)}, {silent: true});
        this.isOp();
        this.view = new _kiwi.view.Member({"model": this});
    },
    addMode: function (mode) {
        var modes_to_add = mode.split(''),
            modes, prefix;

        modes = this.get("modes");
        $.each(modes_to_add, function (index, item) {
            modes.push(item);
        });

        modes = this.sortModes(modes);
        this.set({"prefix": this.getPrefix(modes), "modes": modes});
        this.isOp();

        this.view.render();
    },
    removeMode: function (mode) {
        var modes_to_remove = mode.split(''),
            modes, prefix;

        modes = this.get("modes");
        modes = _.reject(modes, function (m) {
            return (_.indexOf(modes_to_remove, m) !== -1);
        });

        this.set({"prefix": this.getPrefix(modes), "modes": modes});
        this.isOp();

        this.view.render();
    },
    getPrefix: function (modes) {
        var prefix = '';
        var user_prefixes = _kiwi.gateway.get('user_prefixes');

        if (typeof modes[0] !== 'undefined') {
            prefix = _.detect(user_prefixes, function (prefix) {
                return prefix.mode === modes[0];
            });
            prefix = (prefix) ? prefix.symbol : '';
        }
        return prefix;
    },
    stripPrefix: function (nick) {
        var tmp = nick, i, j, k, nick_char;
        var user_prefixes = _kiwi.gateway.get('user_prefixes');
        i = 0;

        nick_character_loop:
        for (j = 0; j < nick.length; j++) {
            nick_char = nick.charAt(j);
            for (k = 0; k < user_prefixes.length; k++) {
                if (nick_char === user_prefixes[k].symbol) {
                    i++;
                    continue nick_character_loop;
                }
            }
            break;
        }

        return tmp.substr(i);
    },
    displayNick: function (full) {
        var display = this.get('nick');

        if (full) {
            if (this.get("ident")) {
                display += ' [' + this.get("ident") + '@' + this.get("hostname") + ']';
            }
        }

        return display;
    },
    isOp: function () {
        var user_prefixes = _kiwi.gateway.get('user_prefixes'),
            modes = this.get('modes'),
            o, max_mode;
        if (modes.length > 0) {
            o = _.indexOf(user_prefixes, _.find(user_prefixes, function (prefix) {
                return prefix.mode === 'o';
            }));
            max_mode = _.indexOf(user_prefixes, _.find(user_prefixes, function (prefix) {
                return prefix.mode === modes[0];
            }));
            if ((max_mode === -1) || (max_mode > o)) {
                this.set({"is_op": false}, {silent: true});
            } else {
                this.set({"is_op": true}, {silent: true});
            }
        } else {
            this.set({"is_op": false}, {silent: true});
        }
    }
});


_kiwi.model.MemberList = Backbone.Collection.extend({
    model: _kiwi.model.Member,
    comparator: function (a, b) {
        var i, a_modes, b_modes, a_idx, b_idx, a_nick, b_nick;
        var user_prefixes = _kiwi.gateway.get('user_prefixes');
        a_modes = a.get("modes");
        b_modes = b.get("modes");
        // Try to sort by modes first
        if (a_modes.length > 0) {
            // a has modes, but b doesn't so a should appear first
            if (b_modes.length === 0) {
                return -1;
            }
            a_idx = b_idx = -1;
            // Compare the first (highest) mode
            for (i = 0; i < user_prefixes.length; i++) {
                if (user_prefixes[i].mode === a_modes[0]) {
                    a_idx = i;
                }
            }
            for (i = 0; i < user_prefixes.length; i++) {
                if (user_prefixes[i].mode === b_modes[0]) {
                    b_idx = i;
                }
            }
            if (a_idx < b_idx) {
                return -1;
            } else if (a_idx > b_idx) {
                return 1;
            }
            // If we get to here both a and b have the same highest mode so have to resort to lexicographical sorting

        } else if (b_modes.length > 0) {
            // b has modes but a doesn't so b should appear first
            return 1;
        }
        a_nick = a.get("nick").toLocaleUpperCase();
        b_nick = b.get("nick").toLocaleUpperCase();
        // Lexicographical sorting
        if (a_nick < b_nick) {
            return -1;
        } else if (a_nick > b_nick) {
            return 1;
        } else {
            return 0;
        }
    },
    initialize: function (options) {
        this.view = new _kiwi.view.MemberList({"model": this});
    },
    getByNick: function (nick) {
        if (typeof nick !== 'string') return;
        return this.find(function (m) {
            return nick.toLowerCase() === m.get('nick').toLowerCase();
        });
    }
});


_kiwi.model.NewConnection = Backbone.Collection.extend({
    initialize: function() {
        this.view = new _kiwi.view.ServerSelect();

        this.view.bind('server_connect', this.onMakeConnection, this);

    },


    onMakeConnection: function(new_connection_event) {
        var that = this,
            transport_path = '',
            auto_connect_details = new_connection_event;

        this.view.networkConnecting();


        _kiwi.gateway.set('kiwi_server', _kiwi.app.kiwi_server);
        _kiwi.gateway.connect(function() {
            that.makeConnection(new_connection_event);
        });


    },


    onKiwiServerNotFound: function() {
        this.view.showError();
    },


    makeConnection: function(new_connection_event) {
        var that = this;

        this.connect_details = new_connection_event;

        _kiwi.gateway.newConnection({
            nick: new_connection_event.nick,
            host: new_connection_event.server,
            port: new_connection_event.port,
            ssl: new_connection_event.ssl,
            password: new_connection_event.password,
            options: new_connection_event.options
        }, function(err, network) {
            that.onNewNetwork(err, network);
        });
    },


    onNewNetwork: function(err, network) {
        // Show any errors if given
        if (err) {
            this.view.showError(err);
        }

        if (network && this.connect_details) {
            network.auto_join = {
                channel: this.connect_details.channel,
                key: this.connect_details.channel_key
            };
        }


        // Show the server panel if this is our first network
        if (network && network.get('connection_id') === 0) {
            network.panels.server.view.show();
        }
    }
});


_kiwi.model.Panel = Backbone.Model.extend({
    initialize: function (attributes) {
        var name = this.get("name") || "";
        this.view = new _kiwi.view.Panel({"model": this, "name": name});
        this.set({
            "scrollback": [],
            "name": name
        }, {"silent": true});
    },

    closePanel: function () {
        if (this.view) {
            this.view.unbind();
            this.view.remove();
            this.view = undefined;
            delete this.view;
        }

        var members = this.get('members');
        if (members) {
            members.reset([]);
            this.unset('members');
        }

        this.get('panel_list').remove(this);

        this.unbind();
        this.destroy();

        // If closing the active panel, switch to the server panel
        if (this === _kiwi.app.panels().active) {
            _kiwi.app.connections.active_connection.panels.server.view.show();
        }
    },

    // Alias to closePanel() for child objects to override
    close: function () {
        return this.closePanel();
    },

    isChannel: function () {
        var channel_prefix = _kiwi.gateway.get('channel_prefix'),
            this_name = this.get('name');

        if (this.isApplet() || !this_name) return false;
        return (channel_prefix.indexOf(this_name[0]) > -1);
    },

    isQuery: function () {
        if (!this.isChannel() && !this.isApplet() && !this.isServer()) {
            return true;
        }

        return false;
    },

    isApplet: function () {
        return this.applet ? true : false;
    },

    isServer: function () {
        return this.server ? true : false;
    },

    isActive: function () {
        return (_kiwi.app.panels().active === this);
    }
});


_kiwi.model.PanelList = Backbone.Collection.extend({
    model: _kiwi.model.Panel,

    comparator: function (chan) {
        return chan.get('name');
    },
    initialize: function (elements, network) {
        var that = this;

        // If this PanelList is associated with a network/connection
        if (network) {
            this.network = network;
        }

        this.view = new _kiwi.view.Tabs({model: this});

        // Holds the active panel
        this.active = null;

        // Keep a tab on the active panel
        this.bind('active', function (active_panel) {
            this.active = active_panel;
        }, this);

        this.bind('add', function(panel) {
            panel.set('panel_list', this);
        });
    },



    getByCid: function (cid) {
        if (typeof name !== 'string') return;

        return this.find(function (c) {
            return cid === c.cid;
        });
    },



    getByName: function (name) {
        if (typeof name !== 'string') return;

        return this.find(function (c) {
            return name.toLowerCase() === c.get('name').toLowerCase();
        });
    }
});



_kiwi.model.NetworkPanelList = Backbone.Collection.extend({
    model: _kiwi.model.Network,

    initialize: function() {
        this.view = new _kiwi.view.NetworkTabs({model: this});
        
        this.on('add', this.onNetworkAdd, this);
        this.on('remove', this.onNetworkRemove, this);

        // Current active connection / panel
        this.active_connection = undefined;
        this.active_panel = undefined;

        // TODO: Remove this - legacy
        this.active = undefined;
    },

    getByConnectionId: function(id) {
        return this.find(function(connection){
            return connection.get('connection_id') == id;
        });
    },

    panels: function() {
        var panels = [];

        this.each(function(network) {
            panels = panels.concat(network.panels.models);
        });

        return panels;
    },


    onNetworkAdd: function(network) {
        network.panels.on('active', this.onPanelActive, this);

        // if it's our first connection, set it active
        if (this.models.length === 1) {
            this.active_connection = network;
            this.active_panel = network.panels.server;

            // TODO: Remove this - legacy
            this.active = this.active_panel;
        }
    },

    onNetworkRemove: function(network) {
        network.panels.off('active', this.onPanelActive, this);
    },

    onPanelActive: function(panel) {
        var connection = this.getByConnectionId(panel.tab.data('connection_id'));
        this.trigger('active', panel, connection);

        this.active_connection = connection;
        this.active_panel = panel;

        // TODO: Remove this - legacy
        this.active = panel;
    }
});


// TODO: Channel modes
// TODO: Listen to gateway events for anythign related to this channel
_kiwi.model.Channel = _kiwi.model.Panel.extend({
    initialize: function (attributes) {
        var name = this.get("name") || "",
            members;

        this.set({
            "members": new _kiwi.model.MemberList(),
            "name": name,
            "scrollback": [],
            "topic": ""
        }, {"silent": true});

        this.view = new _kiwi.view.Channel({"model": this, "name": name});

        members = this.get("members");
        members.channel = this;
        members.bind("add", function (member, members, options) {
            var show_message = _kiwi.global.settings.get('show_joins_parts');
            if (show_message === false) {
                return;
            }

            this.addMsg(' ', '== ' + _kiwi.global.i18n.translate('client_models_channel_join').fetch(member.displayNick(true)), 'action join', {time: options.kiwi.time});
        }, this);

        members.bind("remove", function (member, members, options) {
            var show_message = _kiwi.global.settings.get('show_joins_parts');
            var msg = (options.kiwi.message) ? '(' + options.kiwi.message + ')' : '';

            if (options.kiwi.type === 'quit' && show_message) {
                this.addMsg(' ', '== ' + _kiwi.global.i18n.translate('client_models_channel_quit').fetch(member.displayNick(true), msg), 'action quit', {time: options.kiwi.time});

            } else if (options.kiwi.type === 'kick') {

                if (!options.kiwi.current_user_kicked) {
                    //If user kicked someone, show the message regardless of settings.
                    if (show_message || options.kiwi.current_user_initiated) {
                        this.addMsg(' ', '== ' + _kiwi.global.i18n.translate('client_models_channel_kicked').fetch(member.displayNick(true), options.kiwi.by, msg), 'action kick', {time: options.kiwi.time});
                    }
                } else {
                    this.addMsg(' ', '== ' + _kiwi.global.i18n.translate('client_models_channel_selfkick').fetch(options.kiwi.by, msg), 'action kick', {time: options.kiwi.time});
                }
            } else if (show_message) {
                this.addMsg(' ', '== ' + _kiwi.global.i18n.translate('client_models_channel_part').fetch(member.displayNick(true), msg), 'action part', {time: options.kiwi.time});
            }
        }, this);
    },


    addMsg: function (nick, msg, type, opts) {
        var message_obj, bs, d,
            scrollback = (parseInt(_kiwi.global.settings.get('scrollback'), 10) || 250);

        opts = opts || {};

        // Time defaults to now
        if (typeof opts.time === 'number') {
            opts.time = new Date(opts.time);
        } else {
            opts.time = new Date();
        }

        // CSS style defaults to empty string
        if (!opts || typeof opts.style === 'undefined') {
            opts.style = '';
        }

        // Run through the plugins
        message_obj = {"msg": msg, "date": opts.date, "time": opts.time, "nick": nick, "chan": this.get("name"), "type": type, "style": opts.style};
        //tmp = _kiwi.plugs.run('addmsg', message_obj);
        if (!message_obj) {
            return;
        }

        // The CSS class (action, topic, notice, etc)
        if (typeof message_obj.type !== "string") {
            message_obj.type = '';
        }

        // Make sure we don't have NaN or something
        if (typeof message_obj.msg !== "string") {
            message_obj.msg = '';
        }

        // Update the scrollback
        bs = this.get("scrollback");
        if (bs) {
            bs.push(message_obj);

            // Keep the scrolback limited
            if (bs.length > scrollback) {
                bs.splice(scrollback);
            }
            this.set({"scrollback": bs}, {silent: true});
        }

        this.trigger("msg", message_obj);
    },


    clearMessages: function () {
        this.set({'scrollback': []}, {silent: true});
        this.addMsg('', 'Window cleared');

        this.view.render();
    }
});



_kiwi.model.Query = _kiwi.model.Channel.extend({
    initialize: function (attributes) {
        var name = this.get("name") || "",
            members;

        this.view = new _kiwi.view.Channel({"model": this, "name": name});
        this.set({
            "name": name,
            "scrollback": []
        }, {"silent": true});
    }
});


_kiwi.model.Server = _kiwi.model.Channel.extend({
    // Used to determine if this is a server panel
    server: true,

    initialize: function (attributes) {
        var name = "Server";
        this.view = new _kiwi.view.Channel({"model": this, "name": name});
        this.set({
            "scrollback": [],
            "name": name
        }, {"silent": true});

        //this.addMsg(' ', '--> Kiwi IRC: Such an awesome IRC client', '', {style: 'color:#009900;'});
    }
});


_kiwi.model.Applet = _kiwi.model.Panel.extend({
    // Used to determine if this is an applet panel. Applet panel tabs are treated
    // differently than others
    applet: true,


    initialize: function (attributes) {
        // Temporary name
        var name = "applet_"+(new Date().getTime().toString()) + Math.ceil(Math.random()*100).toString();
        this.view = new _kiwi.view.Applet({model: this, name: name});

        this.set({
            "name": name
        }, {"silent": true});

        // Holds the loaded applet
        this.loaded_applet = null;
    },


    // Load an applet within this panel
    load: function (applet_object, applet_name) {
        if (typeof applet_object === 'object') {
            // Make sure this is a valid Applet
            if (applet_object.get || applet_object.extend) {

                // Try find a title for the applet
                this.set('title', applet_object.get('title') || _kiwi.global.i18n.translate('client_models_applet_unknown').fetch());

                // Update the tabs title if the applet changes it
                applet_object.bind('change:title', function (obj, new_value) {
                    this.set('title', new_value);
                }, this);

                // If this applet has a UI, add it now
                this.view.$el.html('');
                if (applet_object.view) {
                    this.view.$el.append(applet_object.view.$el);
                }

                // Keep a reference to this applet
                this.loaded_applet = applet_object;

                this.loaded_applet.trigger('applet_loaded');
            }

        } else if (typeof applet_object === 'string') {
            // Treat this as a URL to an applet script and load it
            this.loadFromUrl(applet_object, applet_name);
        }

        return this;
    },


    loadFromUrl: function(applet_url, applet_name) {
        var that = this;

        this.view.$el.html(_kiwi.global.i18n.translate('client_models_applet_loading').fetch());
        $script(applet_url, function () {
            // Check if the applet loaded OK
            if (!_kiwi.applets[applet_name]) {
                that.view.$el.html(_kiwi.global.i18n.translate('client_models_applet_notfound').fetch());
                return;
            }

            // Load a new instance of this applet
            that.load(new _kiwi.applets[applet_name]());
        });
    },


    close: function () {
        this.view.$el.remove();
        this.destroy();
        
        this.view = undefined;

        // Call the applets dispose method if it has one
        if (this.loaded_applet && this.loaded_applet.dispose) {
            this.loaded_applet.dispose();
        }

        this.closePanel();
    }
},


{
    // Load an applet type once only. If it already exists, return that
    loadOnce: function (applet_name) {

        // See if we have an instance loaded already
        var applet = _.find(_kiwi.app.panels('applets'), function(panel) {
            // Ignore if it's not an applet
            if (!panel.isApplet()) return;

            // Ignore if it doesn't have an applet loaded
            if (!panel.loaded_applet) return;

            if (panel.loaded_applet.get('_applet_name') === applet_name) {
                return true;
            }
        });

        if (applet) return applet;


        // If we didn't find an instance, load a new one up
        return this.load(applet_name);
    },


    load: function (applet_name) {
        var applet;

        // Find the applet within the registered applets
        if (!_kiwi.applets[applet_name]) return;

        // Create the applet and load the content
        applet = new _kiwi.model.Applet();
        applet.load(new _kiwi.applets[applet_name]({_applet_name: applet_name}));

        // Add it into the tab list
        _kiwi.app.applet_panels.add(applet);


        return applet;
    },


    register: function (applet_name, applet) {
        _kiwi.applets[applet_name] = applet;
    }
});


_kiwi.model.PluginManager = Backbone.Model.extend({
    initialize: function () {
        this.$plugin_holder = $('<div id="kiwi_plugins" style="display:none;"></div>')
            .appendTo(_kiwi.app.view.$el);
        this.loaded_plugins = {};
    },

    // Load an applet within this panel
    load: function (url) {
        if (this.loaded_plugins[url]) {
            this.unload(url);
        }

        this.loaded_plugins[url] = $('<div></div>');
        this.loaded_plugins[url].appendTo(this.$plugin_holder)
            .load(url);
    },


    unload: function (url) {
        if (!this.loaded_plugins[url]) {
            return;
        }

        this.loaded_plugins[url].remove();
        delete this.loaded_plugins[url];
    }
});


_kiwi.model.DataStore = Backbone.Model.extend({
	initialize: function () {
		this._namespace = '';
		this.new_data = {};
	},

	namespace: function (new_namespace) {
		if (new_namespace) this._namespace = new_namespace;
		return this._namespace;
	},

	// Overload the original save() method
	save: function () {
		localStorage.setItem(this._namespace, JSON.stringify(this.attributes));
	},

	// Overload the original load() method
	load: function () {
		if (!localStorage) return;

		var data;

		try {
			data = JSON.parse(localStorage.getItem(this._namespace)) || {};
		} catch (error) {
			data = {};
		}

		this.attributes = data;
	}
},

{
	// Generates a new instance of DataStore with a set namespace
	instance: function (namespace, attributes) {
		var datastore = new _kiwi.model.DataStore(attributes);
		datastore.namespace(namespace);
		return datastore;
	}
});


(function () {
    var View = Backbone.View.extend({
        events: {
            'change [data-setting]': 'saveSettings',
            'click [data-setting="theme"]': 'selectTheme',
            'click .register_protocol': 'registerProtocol',
            'click .enable_notifications': 'enableNoticiations'
        },

        initialize: function (options) {
            var text = {
                tabs: _kiwi.global.i18n.translate('client_applets_settings_channelview_tabs').fetch(),
                list: _kiwi.global.i18n.translate('client_applets_settings_channelview_list').fetch(),
                large_amounts_of_chans: _kiwi.global.i18n.translate('client_applets_settings_channelview_list_notice').fetch(),
                join_part: _kiwi.global.i18n.translate('client_applets_settings_notification_joinpart').fetch(),
                timestamps: _kiwi.global.i18n.translate('client_applets_settings_timestamp').fetch(),
                mute: _kiwi.global.i18n.translate('client_applets_settings_notification_sound').fetch(),
                emoticons: _kiwi.global.i18n.translate('client_applets_settings_emoticons').fetch(),
                scroll_history: _kiwi.global.i18n.translate('client_applets_settings_history_length').fetch(),
                languages: _kiwi.app.translations,
                default_client: _kiwi.global.i18n.translate('client_applets_settings_default_client').fetch(),
                make_default: _kiwi.global.i18n.translate('client_applets_settings_default_client_enable').fetch(),
                locale_restart_needed: _kiwi.global.i18n.translate('client_applets_settings_locale_restart_needed').fetch(),
                default_note: _kiwi.global.i18n.translate('client_applets_settings_default_client_notice').fetch('<a href="chrome://settings/handlers">chrome://settings/handlers</a>'),
                html5_notifications: _kiwi.global.i18n.translate('client_applets_settings_html5_notifications').fetch(),
                enable_notifications: _kiwi.global.i18n.translate('client_applets_settings_enable_notifications').fetch()
            };
            this.$el = $(_.template($('#tmpl_applet_settings').html().trim(), text));

            if (!navigator.registerProtocolHandler) {
                this.$el.find('.protocol_handler').remove();
            }

            if (!window.webkitNotifications) {
                this.$el.find('notification_enabler').remove();
            }

            // Incase any settings change while we have this open, update them
            _kiwi.global.settings.on('change', this.loadSettings, this);

            // Now actually show the current settings
            this.loadSettings();

        },

        loadSettings: function () {

            var that = this;

            $.each(_kiwi.global.settings.attributes, function(key, value) {

                var $el = $('[data-setting="' + key + '"]', that.$el);

                // Only deal with settings we have a UI element for
                if (!$el.length)
                    return;

                switch ($el.prop('type')) {
                    case 'checkbox':
                        $el.prop('checked', value);
                        break;
                    case 'radio':
                        $('[data-setting="' + key + '"][value="' + value + '"]', that.$el).prop('checked', true);
                        break;
                    case 'text':
                        $el.val(value);
                        break;
                    case 'select-one':
                        $('[value="' + value + '"]', that.$el).prop('selected', true);
                        break;
                    default:
                        $('[data-setting="' + key + '"][data-value="' + value + '"]', that.$el).addClass('active');
                        break;
                }
            });
        },

        saveSettings: function (event) {
            var value,
                settings = _kiwi.global.settings,
                $setting = $(event.currentTarget, this.$el);

            switch (event.currentTarget.type) {
                case 'checkbox':
                    value = $setting.is(':checked');
                    break;
                case 'radio':
                case 'text':
                    value = $setting.val();
                    break;
                case 'select-one':
                    value = $(event.currentTarget[$setting.prop('selectedIndex')]).val();
                    break;
                default:
                    value = $setting.data('value');
                    break;
            }

            // Stop settings being updated while we're saving one by one
            _kiwi.global.settings.off('change', this.loadSettings, this);
            settings.set($setting.data('setting'), value);
            settings.save();

            // Continue listening for setting changes
            _kiwi.global.settings.on('change', this.loadSettings, this);
        },

        selectTheme: function(event) {
            $('[data-setting="theme"].active', this.$el).removeClass('active');
            $(event.currentTarget).addClass('active').trigger('change');
            event.preventDefault();
        },

        registerProtocol: function (event) {
            navigator.registerProtocolHandler('irc', document.location.origin + _kiwi.app.get('base_path') + '/%s', 'Kiwi IRC');
            navigator.registerProtocolHandler('ircs', document.location.origin + _kiwi.app.get('base_path') + '/%s', 'Kiwi IRC');
        },

        enableNoticiations: function(event){
            window.webkitNotifications.requestPermission();
        }

    });


    var Applet = Backbone.Model.extend({
        initialize: function () {
            this.set('title', _kiwi.global.i18n.translate('client_applets_settings_title').fetch());
            this.view = new View();
        }
    });


    _kiwi.model.Applet.register('kiwi_settings', Applet);
})();



(function () {

    var View = Backbone.View.extend({
        events: {
            "click .chan": "chanClick",
        },



        initialize: function (options) {
            var text = {
                channel_name: _kiwi.global.i18n.translate('client_applets_chanlist_channelname').fetch(),
                users: _kiwi.global.i18n.translate('client_applets_chanlist_users').fetch(),
                topic: _kiwi.global.i18n.translate('client_applets_chanlist_topic').fetch()
            };
            this.$el = $(_.template($('#tmpl_channel_list').html().trim(), text));

            this.channels = [];

            // Sort the table by num. users?
            this.ordered = true;

            // Waiting to add the table back into the DOM?
            this.waiting = false;
        },


        render: function () {
            var table = $('table', this.$el),
                tbody = table.children('tbody:first').detach(),
                that = this,
                channels_length = this.channels.length,
                i;

            tbody.children().each(function (idx, child) {
                if (that.channels[idx].channel === $(child.querySelector('.chan')).data('channel')) {
                    that.channels[idx].dom = tbody[0].removeChild(child);
                }
            });

            if (this.ordered) {
                this.channels.sort(function (a, b) {
                    return b.num_users - a.num_users;
                });
            }

            for (i = 0; i < channels_length; i++) {
                tbody[0].appendChild(this.channels[i].dom);
            }
            table[0].appendChild(tbody[0]);
        },


        chanClick: function (event) {
            if (event.target) {
                _kiwi.gateway.join(null, $(event.target).data('channel'));
            } else {
                // IE...
                _kiwi.gateway.join(null, $(event.srcElement).data('channel'));
            }
        }
    });




    var Applet = Backbone.Model.extend({
        initialize: function () {
            this.set('title', _kiwi.global.i18n.translate('client_applets_chanlist_channellist').fetch());
            this.view = new View();

            this.network = _kiwi.global.components.Network();
            this.network.on('onlist_channel', this.onListChannel, this);
            this.network.on('onlist_start', this.onListStart, this);
        },


        // New channels to add to our list
        onListChannel: function (event) {
            this.addChannel(event.chans);
        },

        // A new, fresh channel list starting
        onListStart: function (event) {
            // TODO: clear out our existing list
        },

        addChannel: function (channels) {
            var that = this;

            if (!_.isArray(channels)) {
                channels = [channels];
            }
            _.each(channels, function (chan) {
                var row;
                row = document.createElement("tr");
                row.innerHTML = '<td><a class="chan" data-channel="' + chan.channel + '">' + _.escape(chan.channel) + '</a></td><td class="num_users" style="text-align: center;">' + chan.num_users + '</td><td style="padding-left: 2em;">' + formatIRCMsg(_.escape(chan.topic)) + '</td>';
                chan.dom = row;
                that.view.channels.push(chan);
            });

            if (!that.view.waiting) {
                that.view.waiting = true;
                _.defer(function () {
                    that.view.render();
                    that.view.waiting = false;
                });
            }
        },


        dispose: function () {
            this.view.channels = null;
            this.view.unbind();
            this.view.$el.html('');
            this.view.remove();
            this.view = null;

            // Remove any network event bindings
            this.network.off();
        }
    });



    _kiwi.model.Applet.register('kiwi_chanlist', Applet);
})();


    (function () {
        var view = Backbone.View.extend({
            events: {
                'click .btn_save': 'onSave'
            },

            initialize: function (options) {
                var that = this,
                    text = {
                        save: _kiwi.global.i18n.translate('client_applets_scripteditor_save').fetch()
                    };
                this.$el = $(_.template($('#tmpl_script_editor').html().trim(), text));

                this.model.on('applet_loaded', function () {
                    that.$el.parent().css('height', '100%');
                    $script(_kiwi.app.get('base_path') + '/assets/libs/ace/ace.js', function (){ that.createAce(); });
                });
            },


            createAce: function () {
                var editor_id = 'editor_' + Math.floor(Math.random()*10000000).toString();
                this.editor_id = editor_id;

                this.$el.find('.editor').attr('id', editor_id);

                this.editor = ace.edit(editor_id);
                this.editor.setTheme("ace/theme/monokai");
                this.editor.getSession().setMode("ace/mode/javascript");

                var script_content = _kiwi.global.settings.get('user_script') || '';
                this.editor.setValue(script_content);
            },


            onSave: function (event) {
                var script_content, user_fn;

                // Build the user script up with some pre-defined components
                script_content = 'var network = kiwi.components.Network();\n';
                script_content += 'var input = kiwi.components.ControlInput();\n';
                script_content += this.editor.getValue() + '\n';

                // Add a dispose method to the user script for cleaning up
                script_content += 'this._dispose = function(){ network.off(); if(this.dispose) this.dispose(); }';

                // Try to compile the user script
                try {
                    user_fn = new Function(script_content);

                    // Dispose any existing user script
                    if (_kiwi.user_script && _kiwi.user_script._dispose)
                        _kiwi.user_script._dispose();

                    // Create and run the new user script
                    _kiwi.user_script = new user_fn();

                } catch (err) {
                    this.setStatus(_kiwi.global.i18n.translate('client_applets_scripteditor_error').fetch(err.toString()));
                    return;
                }

                // If we're this far, no errors occured. Save the user script
                _kiwi.global.settings.set('user_script', this.editor.getValue());
                _kiwi.global.settings.save();

                this.setStatus(_kiwi.global.i18n.translate('client_applets_scripteditor_saved').fetch() + ' :)');
            },


            setStatus: function (status_text) {
                var $status = this.$el.find('.toolbar .status');

                status_text = status_text || '';
                $status.slideUp('fast', function() {
                    $status.text(status_text);
                    $status.slideDown();
                });
            }
        });



        var applet = Backbone.Model.extend({
            initialize: function () {
                var that = this;

                this.set('title', _kiwi.global.i18n.translate('client_applets_scripteditor_title').fetch());
                this.view = new view({model: this});

            }
        });


        _kiwi.model.Applet.register('kiwi_script_editor', applet);
        //_kiwi.model.Applet.loadOnce('kiwi_script_editor');
    })();


/*jslint devel: true, browser: true, continue: true, sloppy: true, forin: true, plusplus: true, maxerr: 50, indent: 4, nomen: true, regexp: true*/
/*globals $, front, gateway, Utilityview */



/**
*   Generate a random string of given length
*   @param      {Number}    string_length   The length of the random string
*   @returns    {String}                    The random string
*/
function randomString(string_length) {
    var chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz",
        randomstring = '',
        i,
        rnum;
    for (i = 0; i < string_length; i++) {
        rnum = Math.floor(Math.random() * chars.length);
        randomstring += chars.substring(rnum, rnum + 1);
    }
    return randomstring;
}

/**
*   String.trim shim
*/
if (typeof String.prototype.trim === 'undefined') {
    String.prototype.trim = function () {
        return this.replace(/^\s+|\s+$/g, "");
    };
}

/**
*   String.lpad shim
*   @param      {Number}    length      The length of padding
*   @param      {String}    characher   The character to pad with
*   @returns    {String}                The padded string
*/
if (typeof String.prototype.lpad === 'undefined') {
    String.prototype.lpad = function (length, character) {
        var padding = "",
            i;
        for (i = 0; i < length; i++) {
            padding += character;
        }
        return (padding + this).slice(-length);
    };
}


/**
*   Convert seconds into hours:minutes:seconds
*   @param      {Number}    secs    The number of seconds to converts
*   @returns    {Object}            An object representing the hours/minutes/second conversion of secs
*/
function secondsToTime(secs) {
    var hours, minutes, seconds, divisor_for_minutes, divisor_for_seconds, obj;
    hours = Math.floor(secs / (60 * 60));

    divisor_for_minutes = secs % (60 * 60);
    minutes = Math.floor(divisor_for_minutes / 60);

    divisor_for_seconds = divisor_for_minutes % 60;
    seconds = Math.ceil(divisor_for_seconds);

    obj = {
        "h": hours,
        "m": minutes,
        "s": seconds
    };
    return obj;
}


/* Command input Alias + re-writing */
function InputPreProcessor () {
    this.recursive_depth = 3;

    this.aliases = {};
    this.vars = {version: 1};

    // Current recursive depth
    var depth = 0;


    // Takes an array of words to process!
    this.processInput = function (input) {
        var words = input || [],
            alias = this.aliases[words[0]],
            alias_len,
            current_alias_word = '',
            compiled = [];

        // If an alias wasn't found, return the original input
        if (!alias) return input;

        // Split the alias up into useable words
        alias = alias.split(' ');
        alias_len = alias.length;

        // Iterate over each word and pop them into the final compiled array.
        // Any $ words are processed with the result ending into the compiled array.
        for (var i=0; i<alias_len; i++) {
            current_alias_word = alias[i];

            // Non $ word
            if (current_alias_word[0] !== '$') {
                compiled.push(current_alias_word);
                continue;
            }

            // Refering to an input word ($N)
            if (!isNaN(current_alias_word[1])) {
                var num = current_alias_word.match(/\$(\d+)(\+)?(\d+)?/);

                // Did we find anything or does the word it refers to non-existant?
                if (!num || !words[num[1]]) continue;

                if (num[2] === '+' && num[3]) {
                    // Add X number of words
                    compiled = compiled.concat(words.slice(parseInt(num[1], 10), parseInt(num[1], 10) + parseInt(num[3], 10)));
                } else if (num[2] === '+') {
                    // Add the remaining of the words
                    compiled = compiled.concat(words.slice(parseInt(num[1], 10)));
                } else {
                    // Add a single word
                    compiled.push(words[parseInt(num[1], 10)]);
                }

                continue;
            }


            // Refering to a variable
            if (typeof this.vars[current_alias_word.substr(1)] !== 'undefined') {

                // Get the variable
                compiled.push(this.vars[current_alias_word.substr(1)]);

                continue;
            }

        }

        return compiled;
    };


    this.process = function (input) {
        input = input || '';

        var words = input.split(' ');

        depth++;
        if (depth >= this.recursive_depth) {
            depth--;
            return input;
        }

        if (this.aliases[words[0]]) {
            words = this.processInput(words);

            if (this.aliases[words[0]]) {
                words = this.process(words.join(' ')).split(' ');
            }

        }

        depth--;
        return words.join(' ');
    };
}


/**
 * Convert HSL to RGB formatted colour
 */
function hsl2rgb(h, s, l) {
    var m1, m2, hue;
    var r, g, b
    s /=100;
    l /= 100;
    if (s == 0)
        r = g = b = (l * 255);
    else {
        function HueToRgb(m1, m2, hue) {
            var v;
            if (hue < 0)
                hue += 1;
            else if (hue > 1)
                hue -= 1;

            if (6 * hue < 1)
                v = m1 + (m2 - m1) * hue * 6;
            else if (2 * hue < 1)
                v = m2;
            else if (3 * hue < 2)
                v = m1 + (m2 - m1) * (2/3 - hue) * 6;
            else
                v = m1;

            return 255 * v;
        }
        if (l <= 0.5)
            m2 = l * (s + 1);
        else
            m2 = l + s - l * s;
        m1 = l * 2 - m2;
        hue = h / 360;
        r = HueToRgb(m1, m2, hue + 1/3);
        g = HueToRgb(m1, m2, hue);
        b = HueToRgb(m1, m2, hue - 1/3);
    }
    return [r,g,b];
}


/**
 * Formats a kiwi message to IRC format
 */
function formatToIrcMsg(message) {
    // Format any colour codes (eg. $c4)
    message = message.replace(/%C(\d)/ig, function(match, colour_number) {
        return String.fromCharCode(3) + colour_number.toString();
    });

    var formatters = {
        B: '\x02',    // Bold
        I: '\x1D',    // Italics
        U: '\x1F',    // Underline
        O: '\x0F'     // Out / Clear formatting
    };
    message = message.replace(/%([BIUO])/ig, function(match, format_code) {
        if (typeof formatters[format_code.toUpperCase()] !== 'undefined')
            return formatters[format_code.toUpperCase()];
    });

    return message;
}


/**
*   Formats a message. Adds bold, underline and colouring
*   @param      {String}    msg The message to format
*   @returns    {String}        The HTML formatted message
*/
function formatIRCMsg (msg) {
    "use strict";
    var out = '',
        currentTag = '',
        openTags = {
            bold: false,
            italic: false,
            underline: false,
            colour: false
        },
        spanFromOpen = function () {
            var style = '',
                colours;
            if (!(openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                return '';
            } else {
                style += (openTags.bold) ? 'font-weight: bold; ' : '';
                style += (openTags.italic) ? 'font-style: italic; ' : '';
                style += (openTags.underline) ? 'text-decoration: underline; ' : '';
                if (openTags.colour) {
                    colours = openTags.colour.split(',');
                    style += 'color: ' + colours[0] + ((colours[1]) ? '; background-color: ' + colours[1] + ';' : '');
                }
                return '<span class="format_span" style="' + style + '">';
            }
        },
        colourMatch = function (str) {
            var re = /^\x03(([0-9][0-9]?)(,([0-9][0-9]?))?)/;
            return re.exec(str);
        },
        hexFromNum = function (num) {
            switch (parseInt(num, 10)) {
            case 0:
                return '#FFFFFF';
            case 1:
                return '#000000';
            case 2:
                return '#000080';
            case 3:
                return '#008000';
            case 4:
                return '#FF0000';
            case 5:
                return '#800040';
            case 6:
                return '#800080';
            case 7:
                return '#FF8040';
            case 8:
                return '#FFFF00';
            case 9:
                return '#80FF00';
            case 10:
                return '#008080';
            case 11:
                return '#00FFFF';
            case 12:
                return '#0000FF';
            case 13:
                return '#FF55FF';
            case 14:
                return '#808080';
            case 15:
                return '#C0C0C0';
            default:
                return null;
            }
        },
        i = 0,
        colours = [],
        match;

    for (i = 0; i < msg.length; i++) {
        switch (msg[i]) {
        case '\x02':
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                out += currentTag + '</span>';
            }
            openTags.bold = !openTags.bold;
            currentTag = spanFromOpen();
            break;
        case '\x1D':
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                out += currentTag + '</span>';
            }
            openTags.italic = !openTags.italic;
            currentTag = spanFromOpen();
            break;
        case '\x1F':
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                out += currentTag + '</span>';
            }
            openTags.underline = !openTags.underline;
            currentTag = spanFromOpen();
            break;
        case '\x03':
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                out += currentTag + '</span>';
            }
            match = colourMatch(msg.substr(i, 6));
            if (match) {
                i += match[1].length;
                // 2 & 4
                colours[0] = hexFromNum(match[2]);
                if (match[4]) {
                    colours[1] = hexFromNum(match[4]);
                }
                openTags.colour = colours.join(',');
            } else {
                openTags.colour = false;
            }
            currentTag = spanFromOpen();
            break;
        case '\x0F':
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                out += currentTag + '</span>';
            }
            openTags.bold = openTags.italic = openTags.underline = openTags.colour = false;
            break;
        default:
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                currentTag += msg[i];
            } else {
                out += msg[i];
            }
            break;
        }
    }
    if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
        out += currentTag + '</span>';
    }
    return out;
}


function formatDate (d) {
    d = d || new Date();
    return d.toLocaleDateString() + ', ' + d.getHours().toString() + ':' + d.getMinutes().toString() + ':' + d.getSeconds().toString();
}

function escapeRegex (str) {
    return str.replace(/[\[\\\^\$\.\|\?\*\+\(\)]/g, '\\$&');
}

function emoticonFromText(str) {
    var words_in = str.split(' '),
        words_out = [],
        i,
        pushEmoticon = function (alt, emote_name) {
            words_out.push('<i class="emoticon ' + emote_name + '">' + alt + '</i>');
        };

    for (i = 0; i < words_in.length; i++) {
        switch(words_in[i]) {
        case ':)':
            pushEmoticon(':)', 'smile');
            break;
        case ':(':
            pushEmoticon(':(', 'sad');
            break;
        case ':3':
            pushEmoticon(':3', 'lion');
            break;
        case ';3':
            pushEmoticon(';3', 'winky_lion');
            break;
        case ':s':
        case ':S':
            pushEmoticon(':s', 'confused');
            break;
        case ';(':
        case ';_;':
            pushEmoticon(';(', 'cry');
            break;
        case ';)':
            pushEmoticon(';)', 'wink');
            break;
        case ';D':
            pushEmoticon(';D"', 'wink_happy');
            break;
        case ':P':
        case ':p':
            pushEmoticon(':P', 'tongue');
            break;
        case 'xP':
            pushEmoticon('xP', 'cringe_tongue');
            break;
        case ':o':
        case ':O':
        case ':0':
            pushEmoticon(':o', 'shocked');
            break;
        case ':D':
            pushEmoticon(':D', 'happy');
            break;
        case '^^':
        case '^.^':
            pushEmoticon('^^,', 'eyebrows');
            break;
        case '&lt;3':
            pushEmoticon('<3', 'heart');
            break;
        case '&gt;_&lt;':
        case '&gt;.&lt;':
            pushEmoticon('>_<', 'doh');
            break;
        case 'XD':
        case 'xD':
            pushEmoticon('xD', 'big_grin');
            break;
        case 'o.0':
        case 'o.O':
            pushEmoticon('o.0', 'wide_eye_right');
            break;
        case '0.o':
        case 'O.o':
            pushEmoticon('0.o', 'wide_eye_left');
            break;
        case ':\\':
        case '=\\':
        case ':/':
        case '=/':
            pushEmoticon(':\\', 'unsure');
            break;
        default:
            words_out.push(words_in[i]);
        }
    }

    return words_out.join(' ');
}

// Code based on http://anentropic.wordpress.com/2009/06/25/javascript-iso8601-parser-and-pretty-dates/#comment-154
function parseISO8601(str) {
    if (Date.prototype.toISOString) {
        return new Date(str);
    } else {
        var parts = str.split('T'),
            dateParts = parts[0].split('-'),
            timeParts = parts[1].split('Z'),
            timeSubParts = timeParts[0].split(':'),
            timeSecParts = timeSubParts[2].split('.'),
            timeHours = Number(timeSubParts[0]),
            _date = new Date();

        _date.setUTCFullYear(Number(dateParts[0]));
        _date.setUTCDate(1);
        _date.setUTCMonth(Number(dateParts[1])-1);
        _date.setUTCDate(Number(dateParts[2]));
        _date.setUTCHours(Number(timeHours));
        _date.setUTCMinutes(Number(timeSubParts[1]));
        _date.setUTCSeconds(Number(timeSecParts[0]));
        if (timeSecParts[1]) {
            _date.setUTCMilliseconds(Number(timeSecParts[1]));
        }

        return _date;
    }
}


_kiwi.view.Panel = Backbone.View.extend({
    tagName: "div",
    className: "panel",

    events: {
    },

    initialize: function (options) {
        this.initializePanel(options);
    },

    initializePanel: function (options) {
        this.$el.css('display', 'none');
        options = options || {};

        // Containing element for this panel
        if (options.container) {
            this.$container = $(options.container);
        } else {
            this.$container = $('#kiwi .panels .container1');
        }

        this.$el.appendTo(this.$container);

        this.alert_level = 0;

        this.model.set({"view": this}, {"silent": true});
    },

    render: function () {
    },


    show: function () {
        var $this = this.$el;

        // Hide all other panels and show this one
        this.$container.children('.panel').css('display', 'none');
        $this.css('display', 'block');

        // Show this panels memberlist
        var members = this.model.get("members");
        if (members) {
            $('#kiwi .memberlists').removeClass('disabled');
            members.view.show();
        } else {
            // Memberlist not found for this panel, hide any active ones
            $('#kiwi .memberlists').addClass('disabled').children().removeClass('active');
        }

        // Remove any alerts and activity counters for this panel
        this.alert('none');
        this.model.tab.find('.activity').text('0').addClass('zero');

        _kiwi.app.panels.trigger('active', this.model, _kiwi.app.panels().active);
        this.model.trigger('active', this.model);

        _kiwi.app.view.doLayout();

        this.scrollToBottom(true);
    },


    alert: function (level) {
        // No need to highlight if this si the active panel
        if (this.model == _kiwi.app.panels().active) return;

        var types, type_idx;
        types = ['none', 'action', 'activity', 'highlight'];

        // Default alert level
        level = level || 'none';

        // If this alert level does not exist, assume clearing current level
        type_idx = _.indexOf(types, level);
        if (!type_idx) {
            level = 'none';
            type_idx = 0;
        }

        // Only 'upgrade' the alert. Never down (unless clearing)
        if (type_idx !== 0 && type_idx <= this.alert_level) {
            return;
        }

        // Clear any existing levels
        this.model.tab.removeClass(function (i, css) {
            return (css.match(/\balert_\S+/g) || []).join(' ');
        });

        // Add the new level if there is one
        if (level !== 'none') {
            this.model.tab.addClass('alert_' + level);
        }

        this.alert_level = type_idx;
    },


    // Scroll to the bottom of the panel
    scrollToBottom: function (force_down) {
        // If this isn't the active panel, don't scroll
        if (this.model !== _kiwi.app.panels().active) return;

        // Don't scroll down if we're scrolled up the panel a little
        if (force_down || this.$container.scrollTop() + this.$container.height() > this.$el.outerHeight() - 150) {
            this.$container[0].scrollTop = this.$container[0].scrollHeight;
        }
    }
});


_kiwi.view.Channel = _kiwi.view.Panel.extend({
    events: function(){
        var parent_events = this.constructor.__super__.events;

        if(_.isFunction(parent_events)){
            parent_events = parent_events();
        }
        return _.extend({}, parent_events, {
            'click .msg .nick' : 'nickClick',
            "click .chan": "chanClick",
            'click .media .open': 'mediaClick',
            'mouseenter .msg .nick': 'msgEnter',
            'mouseleave .msg .nick': 'msgLeave'
        });
    },

    initialize: function (options) {
        this.initializePanel(options);

        // Container for all the messages
        this.$messages = $('<div class="messages"></div>');
        this.$el.append(this.$messages);

        this.model.bind('change:topic', this.topic, this);

        if (this.model.get('members')) {
            this.model.get('members').bind('add', function (member) {
                if (member.get('nick') === this.model.collection.network.get('nick')) {
                    this.$el.find('.initial_loader').slideUp(function () {
                        $(this).remove();
                    });
                }
            }, this);
        }

        // Only show the loader if this is a channel (ie. not a query)
        if (this.model.isChannel()) {
            this.$el.append('<div class="initial_loader" style="margin:1em;text-align:center;"> ' + _kiwi.global.i18n.translate('client_views_channel_joining').fetch() + ' <span class="loader"></span></div>');
        }

        this.model.bind('msg', this.newMsg, this);
        this.msg_count = 0;
    },


    render: function () {
        var that = this;

        this.$messages.empty();
        _.each(this.model.get('scrollback'), function (msg) {
            that.newMsg(msg);
        });
    },


    newMsg: function (msg) {
        var re, line_msg,
            nick_colour_hex, nick_hex, is_highlight, msg_css_classes = '',
            time_difference,
            sb = this.model.get('scrollback'),
            prev_msg = sb[sb.length-2];

        // Nick highlight detecting
        if ((new RegExp('(^|\\W)(' + escapeRegex(_kiwi.app.connections.active_connection.get('nick')) + ')(\\W|$)', 'i')).test(msg.msg)) {
            is_highlight = true;
            msg_css_classes += ' highlight';
        }

        // Escape any HTML that may be in here
        msg.msg =  $('<div />').text(msg.msg).html();

        // Make the channels clickable
        re = new RegExp('(?:^|\\s)([' + escapeRegex(_kiwi.gateway.get('channel_prefix')) + '][^ ,\\007]+)', 'g');
        msg.msg = msg.msg.replace(re, function (match) {
            return '<a class="chan" data-channel="' + match.trim() + '">' + match + '</a>';
        });


        // Parse any links found
        msg.msg = msg.msg.replace(/(([A-Za-z][A-Za-z0-9\-]*\:\/\/)|(www\.))([\w.\-]+)([a-zA-Z]{2,6})(:[0-9]+)?(\/[\w#!:.?$'()[\]*,;~+=&%@!\-\/]*)?/gi, function (url) {
            var nice = url,
                extra_html = '';

            // Add the http if no protoocol was found
            if (url.match(/^www\./)) {
                url = 'http://' + url;
            }

            // Shorten the displayed URL if it's going to be too long
            if (nice.length > 100) {
                nice = nice.substr(0, 100) + '...';
            }

            // Get any media HTML if supported
            extra_html = _kiwi.view.MediaMessage.buildHtml(url);

            // Make the link clickable
            return '<a class="link_ext" target="_blank" rel="nofollow" href="' + url + '">' + nice + '</a>' + extra_html;
        });


        // Convert IRC formatting into HTML formatting
        msg.msg = formatIRCMsg(msg.msg);

        // Replace text emoticons with images
        if (_kiwi.global.settings.get('show_emoticons')) {
            msg.msg = emoticonFromText(msg.msg);
        }

        // Add some colours to the nick (Method based on IRSSIs nickcolor.pl)
        nick_colour_hex = (function (nick) {
            var nick_int = 0, rgb;

            _.map(nick.split(''), function (i) { nick_int += i.charCodeAt(0); });
            rgb = hsl2rgb(nick_int % 255, 70, 35);
            rgb = rgb[2] | (rgb[1] << 8) | (rgb[0] << 16);

            return '#' + rgb.toString(16);
        })(msg.nick);

        msg.nick_style = 'color:' + nick_colour_hex + ';';

        // Generate a hex string from the nick to be used as a CSS class name
        nick_hex = msg.nick_css_class = '';
        if (msg.nick) {
            _.map(msg.nick.split(''), function (char) {
                nick_hex += char.charCodeAt(0).toString(16);
            });
            msg_css_classes += ' nick_' + nick_hex;
        }

        if (prev_msg) {
            // Time difference between this message and the last (in minutes)
            time_difference = (msg.time.getTime() - prev_msg.time.getTime())/1000/60;
            if (prev_msg.nick === msg.nick && time_difference < 1) {
                msg_css_classes += ' repeated_nick';
            }
        }

        // Build up and add the line
        msg.msg_css_classes = msg_css_classes;
        msg.time_string = msg.time.getHours().toString().lpad(2, "0") + ":" + msg.time.getMinutes().toString().lpad(2, "0") + ":" + msg.time.getSeconds().toString().lpad(2, "0");
        line_msg = '<div class="msg <%= type %> <%= msg_css_classes %>"><div class="time"><%- time_string %></div><div class="nick" style="<%= nick_style %>"><%- nick %></div><div class="text" style="<%= style %>"><%= msg %> </div></div>';
        this.$messages.append(_.template(line_msg, msg));

        // Activity/alerts based on the type of new message
        if (msg.type.match(/^action /)) {
            this.alert('action');

        } else if (is_highlight) {
            _kiwi.app.view.alertWindow('* ' + _kiwi.global.i18n.translate('client_views_panel_activity').fetch());
            _kiwi.app.view.favicon.newHighlight();
            _kiwi.app.view.playSound('highlight');
            _kiwi.app.view.showNotification(this.model.get('name'), msg.msg);
            this.alert('highlight');

        } else {
            // If this is the active panel, send an alert out
            if (this.model.isActive()) {
                _kiwi.app.view.alertWindow('* ' + _kiwi.global.i18n.translate('client_views_panel_activity').fetch());
            }
            this.alert('activity');
        }

        if (this.model.isQuery() && !this.model.isActive()) {
            _kiwi.app.view.alertWindow('* ' + _kiwi.global.i18n.translate('client_views_panel_activity').fetch());

            // Highlights have already been dealt with above
            if (!is_highlight) {
                _kiwi.app.view.favicon.newHighlight();
            }

            _kiwi.app.view.showNotification(this.model.get('name'), msg.msg);
            _kiwi.app.view.playSound('highlight');
        }

        // Update the activity counters
        (function () {
            // Only inrement the counters if we're not the active panel
            if (this.model.isActive()) return;

            var $act = this.model.tab.find('.activity');
            $act.text((parseInt($act.text(), 10) || 0) + 1);
            if ($act.text() === '0') {
                $act.addClass('zero');
            } else {
                $act.removeClass('zero');
            }
        }).apply(this);

        this.scrollToBottom();

        // Make sure our DOM isn't getting too large (Acts as scrollback)
        this.msg_count++;
        if (this.msg_count > (parseInt(_kiwi.global.settings.get('scrollback'), 10) || 250)) {
            $('.msg:first', this.$messages).remove();
            this.msg_count--;
        }
    },


    topic: function (topic) {
        if (typeof topic !== 'string' || !topic) {
            topic = this.model.get("topic");
        }

        this.model.addMsg('', '== ' + _kiwi.global.i18n.translate('client_views_channel_topic').fetch(this.model.get('name'), topic), 'topic');

        // If this is the active channel then update the topic bar
        if (_kiwi.app.panels().active === this) {
            _kiwi.app.topicbar.setCurrentTopic(this.model.get("topic"));
        }
    },

    // Click on a nickname
    nickClick: function (event) {
        var nick = $(event.currentTarget).text(),
            members = this.model.get('members'),
            member, query, userbox, menubox;

        if (members) {
            member = members.getByNick(nick);
            if (member) {
                userbox = new _kiwi.view.UserBox();
                userbox.member = member;
                userbox.channel = this.model;

                // Hide the op related items if we're not an op
                if (!members.getByNick(_kiwi.app.connections.active_connection.get('nick')).get('is_op')) {
                    userbox.$el.children('.if_op').remove();
                }

                menubox = new _kiwi.view.MenuBox(member.get('nick') || 'User');
                menubox.addItem('userbox', userbox.$el);
                menubox.show();

                // Position the userbox + menubox
                (function() {
                    var t = event.pageY,
                        m_bottom = t + menubox.$el.outerHeight(),  // Where the bottom of menu will be
                        memberlist_bottom = this.$el.parent().offset().top + this.$el.parent().outerHeight();

                    // If the bottom of the userbox is going to be too low.. raise it
                    if (m_bottom > memberlist_bottom){
                        t = memberlist_bottom - menubox.$el.outerHeight();
                    }

                    // Set the new positon
                    menubox.$el.offset({
                        left: event.clientX,
                        top: t
                    });
                }).call(this);
            }
        }
    },


    chanClick: function (event) {
        if (event.target) {
            _kiwi.gateway.join(null, $(event.target).data('channel'));
        } else {
            // IE...
            _kiwi.gateway.join(null, $(event.srcElement).data('channel'));
        }
    },


    mediaClick: function (event) {
        var $media = $(event.target).parents('.media');
        var media_message;

        if ($media.data('media')) {
            media_message = $media.data('media');
        } else {
            media_message = new _kiwi.view.MediaMessage({el: $media[0]});

            // Cache this MediaMessage instance for when it's opened again
            $media.data('media', media_message);
        }

        media_message.toggle();
    },


    // Cursor hovers over a message
    msgEnter: function (event) {
        var nick_class;

        // Find a valid class that this element has
        _.each($(event.currentTarget).parent('.msg').attr('class').split(' '), function (css_class) {
            if (css_class.match(/^nick_[a-z0-9]+/i)) {
                nick_class = css_class;
            }
        });

        // If no class was found..
        if (!nick_class) return;

        $('.'+nick_class).addClass('global_nick_highlight');
    },


    // Cursor leaves message
    msgLeave: function (event) {
        var nick_class;

        // Find a valid class that this element has
        _.each($(event.currentTarget).parent('.msg').attr('class').split(' '), function (css_class) {
            if (css_class.match(/^nick_[a-z0-9]+/i)) {
                nick_class = css_class;
            }
        });

        // If no class was found..
        if (!nick_class) return;

        $('.'+nick_class).removeClass('global_nick_highlight');
    },
});



_kiwi.view.Applet = _kiwi.view.Panel.extend({
    className: 'panel applet',
    initialize: function (options) {
        this.initializePanel(options);
    }
});


_kiwi.view.Application = Backbone.View.extend({
    initialize: function () {
        var that = this;

        this.$el = $($('#tmpl_application').html().trim());
        this.el = this.$el[0];

        $(this.model.get('container') || 'body').append(this.$el);

        this.elements = {
            panels:        this.$el.find('.panels'),
            memberlists:   this.$el.find('.memberlists'),
            toolbar:       this.$el.find('.toolbar'),
            controlbox:    this.$el.find('.controlbox'),
            resize_handle: this.$el.find('.memberlists_resize_handle')
        };

        $(window).resize(function() { that.doLayout.apply(that); });
        this.elements.toolbar.resize(function() { that.doLayout.apply(that); });
        this.elements.controlbox.resize(function() { that.doLayout.apply(that); });

        // Change the theme when the config is changed
        _kiwi.global.settings.on('change:theme', this.updateTheme, this);
        this.updateTheme(getQueryVariable('theme'));

        _kiwi.global.settings.on('change:channel_list_style', this.setTabLayout, this);
        this.setTabLayout(_kiwi.global.settings.get('channel_list_style'));

        _kiwi.global.settings.on('change:show_timestamps', this.displayTimestamps, this);
        this.displayTimestamps(_kiwi.global.settings.get('show_timestamps'));

        this.$el.appendTo($('body'));
        this.doLayout();

        $(document).keydown(this.setKeyFocus);

        // Confirmation require to leave the page
        window.onbeforeunload = function () {
            if (_kiwi.gateway.isConnected()) {
                return _kiwi.global.i18n.translate('client_views_application_close_notice').fetch();
            }
        };

        // Keep tabs on the browser having focus
        this.has_focus = true;

        $(window).on('focus', function () {
            that.has_focus = true;
        });
        $(window).on('blur', function () {
            that.has_focus = false;
        });


        this.favicon = new _kiwi.view.Favicon();
        this.initSound();
    },



    updateTheme: function (theme_name) {
        // If called by the settings callback, get the correct new_value
        if (theme_name === _kiwi.global.settings) {
            theme_name = arguments[1];
        }

        // If we have no theme specified, get it from the settings
        if (!theme_name) theme_name = _kiwi.global.settings.get('theme');

        // Clear any current theme
        this.$el.removeClass(function (i, css) {
            return (css.match(/\btheme_\S+/g) || []).join(' ');
        });

        // Apply the new theme
        this.$el.addClass('theme_' + (theme_name || 'relaxed'));
    },


    setTabLayout: function (layout_style) {
        // If called by the settings callback, get the correct new_value
        if (layout_style === _kiwi.global.settings) {
            layout_style = arguments[1];
        }

        if (layout_style == 'list') {
            this.$el.addClass('chanlist_treeview');
        } else {
            this.$el.removeClass('chanlist_treeview');
        }

        this.doLayout();
    },


    displayTimestamps: function (show_timestamps) {
        // If called by the settings callback, get the correct new_value
        if (show_timestamps === _kiwi.global.settings) {
            show_timestamps = arguments[1];
        }

        if (show_timestamps) {
            this.$el.addClass('timestamps');
        } else {
            this.$el.removeClass('timestamps');
        }
    },


    // Globally shift focus to the command input box on a keypress
    setKeyFocus: function (ev) {
        // If we're copying text, don't shift focus
        if (ev.ctrlKey || ev.altKey || ev.metaKey) {
            return;
        }

        // If we're typing into an input box somewhere, ignore
        if ((ev.target.tagName.toLowerCase() === 'input') || (ev.target.tagName.toLowerCase() === 'textarea') || $(ev.target).attr('contenteditable')) {
            return;
        }

        $('#kiwi .controlbox .inp').focus();
    },


    doLayout: function () {
        var el_kiwi = this.$el;
        var el_panels = this.elements.panels;
        var el_memberlists = this.elements.memberlists;
        var el_toolbar = this.elements.toolbar;
        var el_controlbox = this.elements.controlbox;
        var el_resize_handle = this.elements.resize_handle;

        if (!el_kiwi.is(':visible')) {
            return;
        }

        var css_heights = {
            top: el_toolbar.outerHeight(true),
            bottom: el_controlbox.outerHeight(true)
        };


        // If any elements are not visible, full size the panals instead
        if (!el_toolbar.is(':visible')) {
            css_heights.top = 0;
        }

        if (!el_controlbox.is(':visible')) {
            css_heights.bottom = 0;
        }

        // Apply the CSS sizes
        el_panels.css(css_heights);
        el_memberlists.css(css_heights);
        el_resize_handle.css(css_heights);

        // If we have channel tabs on the side, adjust the height
        if (el_kiwi.hasClass('chanlist_treeview')) {
            this.$el.find('.tabs', el_kiwi).css(css_heights);
        }

        // Determine if we have a narrow window (mobile/tablet/or even small desktop window)
        if (el_kiwi.outerWidth() < 400) {
            el_kiwi.addClass('narrow');
        } else {
            el_kiwi.removeClass('narrow');
        }

        // Set the panels width depending on the memberlist visibility
        if (el_memberlists.css('display') != 'none') {
            // Panels to the side of the memberlist
            el_panels.css('right', el_memberlists.outerWidth(true));
            // The resize handle sits overlapping the panels and memberlist
            el_resize_handle.css('left', el_memberlists.position().left - (el_resize_handle.outerWidth(true) / 2));
        } else {
            // Memberlist is hidden so panels to the right edge
            el_panels.css('right', 0);
            // And move the handle just out of sight to the right
            el_resize_handle.css('left', el_panels.outerWidth(true));
        }

        var input_wrap_width = parseInt($('#kiwi .controlbox .input_tools').outerWidth());
        el_controlbox.find('.input_wrap').css('right', input_wrap_width + 7);
    },


    alertWindow: function (title) {
        if (!this.alertWindowTimer) {
            this.alertWindowTimer = new (function () {
                var that = this;
                var tmr;
                var has_focus = true;
                var state = 0;
                var default_title = _kiwi.app.server_settings.client.window_title;
                var title = 'NCHU IRC Client';

                this.setTitle = function (new_title) {
                    new_title = new_title || default_title;
                    window.document.title = new_title;
                    return new_title;
                };

                this.start = function (new_title) {
                    // Don't alert if we already have focus
                    if (has_focus) return;

                    title = new_title;
                    if (tmr) return;
                    tmr = setInterval(this.update, 1000);
                };

                this.stop = function () {
                    // Stop the timer and clear the title
                    if (tmr) clearInterval(tmr);
                    tmr = null;
                    this.setTitle();

                    // Some browsers don't always update the last title correctly
                    // Wait a few seconds and then reset
                    setTimeout(this.reset, 2000);
                };

                this.reset = function () {
                    if (tmr) return;
                    that.setTitle();
                };


                this.update = function () {
                    if (state === 0) {
                        that.setTitle(title);
                        state = 1;
                    } else {
                        that.setTitle();
                        state = 0;
                    }
                };

                $(window).focus(function (event) {
                    has_focus = true;
                    that.stop();

                    // Some browsers don't always update the last title correctly
                    // Wait a few seconds and then reset
                    setTimeout(that.reset, 2000);
                });

                $(window).blur(function (event) {
                    has_focus = false;
                });
            })();
        }

        this.alertWindowTimer.start(title);
    },


    barsHide: function (instant) {
        var that = this;

        if (!instant) {
            this.$el.find('.toolbar').slideUp({queue: false, duration: 400, step: $.proxy(this.doLayout, this)});
            $('#kiwi .controlbox').slideUp({queue: false, duration: 400, step: $.proxy(this.doLayout, this)});
        } else {
            this.$el.find('.toolbar').slideUp(0);
            $('#kiwi .controlbox').slideUp(0);
            this.doLayout();
        }
    },

    barsShow: function (instant) {
        var that = this;

        if (!instant) {
            this.$el.find('.toolbar').slideDown({queue: false, duration: 400, step: $.proxy(this.doLayout, this)});
            $('#kiwi .controlbox').slideDown({queue: false, duration: 400, step: $.proxy(this.doLayout, this)});
        } else {
            this.$el.find('.toolbar').slideDown(0);
            $('#kiwi .controlbox').slideDown(0);
            this.doLayout();
        }
    },


    initSound: function () {
        var that = this,
            base_path = this.model.get('base_path');

        $script(base_path + '/assets/libs/soundmanager2/soundmanager2-nodebug-jsmin.js', function() {
            if (typeof soundManager === 'undefined')
                return;

            soundManager.setup({
                url: base_path + '/assets/libs/soundmanager2/',
                flashVersion: 9, // optional: shiny features (default = 8)// optional: ignore Flash where possible, use 100% HTML5 mode
                preferFlash: true,

                onready: function() {
                    that.sound_object = soundManager.createSound({
                        id: 'highlight',
                        url: base_path + '/assets/sound/highlight.mp3'
                    });
                }
            });
        });
    },


    playSound: function (sound_id) {
        if (!this.sound_object) return;

        if (_kiwi.global.settings.get('mute_sounds'))
            return;

        soundManager.play(sound_id);
    },


    showNotification: function(title, message) {
        var icon = this.model.get('base_path') + '/assets/img/ico.png';

        // Check if we have notification support
        if (!window.webkitNotifications)
            return;

        if (this.has_focus)
            return;

        if (webkitNotifications.checkPermission() === 0){
            window.webkitNotifications.createNotification(icon, title, message).show();
        }
    }
});



_kiwi.view.AppToolbar = Backbone.View.extend({
    events: {
        'click .settings': 'clickSettings'
    },

    initialize: function () {
    },

    clickSettings: function (event) {
        _kiwi.app.controlbox.processInput('/settings');
    }
});


_kiwi.view.ControlBox = Backbone.View.extend({
    events: {
        'keydown .inp': 'process',
        'click .nick': 'showNickChange'
    },

    initialize: function () {
        var that = this;

        this.buffer = [];  // Stores previously run commands
        this.buffer_pos = 0;  // The current position in the buffer

        this.preprocessor = new InputPreProcessor();
        this.preprocessor.recursive_depth = 5;

        // Hold tab autocomplete data
        this.tabcomplete = {active: false, data: [], prefix: ''};

        // Keep the nick view updated with nick changes
        _kiwi.app.connections.on('change:nick', function(connection) {
            // Only update the nick view if it's the active connection
            if (connection !== _kiwi.app.connections.active_connection)
                return;

            $('.nick', that.$el).text(connection.get('nick'));
        });

        // Update our nick view as we flick between connections
        _kiwi.app.connections.on('active', function(panel, connection) {
            $('.nick', that.$el).text(connection.get('nick'));
        });
    },

    showNickChange: function (ev) {
        (new _kiwi.view.NickChangeBox()).render();
    },

    process: function (ev) {
        var that = this,
            inp = $(ev.currentTarget),
            inp_val = inp.val(),
            meta;

        if (navigator.appVersion.indexOf("Mac") !== -1) {
            meta = ev.metaKey;
        } else {
            meta = ev.altKey;
        }

        // If not a tab key, reset the tabcomplete data
        if (this.tabcomplete.active && ev.keyCode !== 9) {
            this.tabcomplete.active = false;
            this.tabcomplete.data = [];
            this.tabcomplete.prefix = '';
        }
        
        switch (true) {
        case (ev.keyCode === 13):              // return
            inp_val = inp_val.trim();

            if (inp_val) {
                $.each(inp_val.split('\n'), function (idx, line) {
                    that.processInput(line);
                });

                this.buffer.push(inp_val);
                this.buffer_pos = this.buffer.length;
            }

            inp.val('');
            return false;

            break;

        case (ev.keyCode === 38):              // up
            if (this.buffer_pos > 0) {
                this.buffer_pos--;
                inp.val(this.buffer[this.buffer_pos]);
            }
            //suppress browsers default behavior as it would set the cursor at the beginning
            return false;

        case (ev.keyCode === 40):              // down
            if (this.buffer_pos < this.buffer.length) {
                this.buffer_pos++;
                inp.val(this.buffer[this.buffer_pos]);
            }
            break;

        case (ev.keyCode === 219 && meta):            // [ + meta
            // Find all the tab elements and get the index of the active tab
            var $tabs = $('#kiwi .tabs').find('li[class!=connection]');
            var cur_tab_ind = (function() {
                for (var idx=0; idx<$tabs.length; idx++){
                    if ($($tabs[idx]).hasClass('active'))
                        return idx;
                }
            })();

            // Work out the previous tab along. Wrap around if needed
            if (cur_tab_ind === 0) {
                $prev_tab = $($tabs[$tabs.length - 1]);
            } else {
                $prev_tab = $($tabs[cur_tab_ind - 1]);
            }

            $prev_tab.click();
            return false;

        case (ev.keyCode === 221 && meta):            // ] + meta
            // Find all the tab elements and get the index of the active tab
            var $tabs = $('#kiwi .tabs').find('li[class!=connection]');
            var cur_tab_ind = (function() {
                for (var idx=0; idx<$tabs.length; idx++){
                    if ($($tabs[idx]).hasClass('active'))
                        return idx;
                }
            })();

            // Work out the next tab along. Wrap around if needed
            if (cur_tab_ind === $tabs.length - 1) {
                $next_tab = $($tabs[0]);
            } else {
                $next_tab = $($tabs[cur_tab_ind + 1]);
            }

            $next_tab.click();
            return false;

        case (ev.keyCode === 9     //Check if ONLY tab is pressed
            && !ev.shiftKey        //(user could be using some browser 
            && !ev.altKey          //keyboard shortcut)
            && !ev.metaKey 
            && !ev.ctrlKey):                     
            this.tabcomplete.active = true;
            if (_.isEqual(this.tabcomplete.data, [])) {
                // Get possible autocompletions
                var ac_data = [],
                    members = _kiwi.app.panels().active.get('members');

                // If we have a members list, get the models. Otherwise empty array
                members = members ? members.models : [];

                $.each(members, function (i, member) {
                    if (!member) return;
                    ac_data.push(member.get('nick'));
                });

                ac_data.push(_kiwi.app.panels().active.get('name'));

                ac_data = _.sortBy(ac_data, function (nick) {
                    return nick;
                });
                this.tabcomplete.data = ac_data;
            }

            if (inp_val[inp[0].selectionStart - 1] === ' ') {
                return false;
            }
            
            (function () {
                var tokens,              // Words before the cursor position
                    val,                 // New value being built up
                    p1,                  // Position in the value just before the nick 
                    newnick,             // New nick to be displayed (cycles through)
                    range,               // TextRange for setting new text cursor position
                    nick,                // Current nick in the value
                    trailing = ': ';     // Text to be inserted after a tabbed nick

                tokens = inp_val.substring(0, inp[0].selectionStart).split(' ');
                if (tokens[tokens.length-1] == ':')
                    tokens.pop();

                // Only add the trailing text if not at the beginning of the line
                if (tokens.length > 1)
                    trailing = '';

                nick  = tokens[tokens.length - 1];

                if (this.tabcomplete.prefix === '') {
                    this.tabcomplete.prefix = nick;
                }

                this.tabcomplete.data = _.select(this.tabcomplete.data, function (n) {
                    return (n.toLowerCase().indexOf(that.tabcomplete.prefix.toLowerCase()) === 0);
                });

                if (this.tabcomplete.data.length > 0) {
                    // Get the current value before cursor position
                    p1 = inp[0].selectionStart - (nick.length);
                    val = inp_val.substr(0, p1);

                    // Include the current selected nick
                    newnick = this.tabcomplete.data.shift();
                    this.tabcomplete.data.push(newnick);
                    val += newnick;

                    if (inp_val.substr(inp[0].selectionStart, 2) !== trailing)
                        val += trailing;

                    // Now include the rest of the current value
                    val += inp_val.substr(inp[0].selectionStart);

                    inp.val(val);

                    // Move the cursor position to the end of the nick
                    if (inp[0].setSelectionRange) {
                        inp[0].setSelectionRange(p1 + newnick.length + trailing.length, p1 + newnick.length + trailing.length);
                    } else if (inp[0].createTextRange) { // not sure if this bit is actually needed....
                        range = inp[0].createTextRange();
                        range.collapse(true);
                        range.moveEnd('character', p1 + newnick.length + trailing.length);
                        range.moveStart('character', p1 + newnick.length + trailing.length);
                        range.select();
                    }
                }
            }).apply(this);
            return false;
        }
    },


    processInput: function (command_raw) {
        var command, params,
            pre_processed;
        
        // The default command
        if (command_raw[0] !== '/' || command_raw.substr(0, 2) === '//') {
            // Remove any slash escaping at the start (ie. //)
            command_raw = command_raw.replace(/^\/\//, '/');

            // Prepend the default command
            command_raw = '/msg ' + _kiwi.app.panels().active.get('name') + ' ' + command_raw;
        }

        // Process the raw command for any aliases
        this.preprocessor.vars.server = _kiwi.app.connections.active_connection.get('name');
        this.preprocessor.vars.channel = _kiwi.app.panels().active.get('name');
        this.preprocessor.vars.destination = this.preprocessor.vars.channel;
        command_raw = this.preprocessor.process(command_raw);

        // Extract the command and parameters
        params = command_raw.split(/\s/);
        if (params[0][0] === '/') {
            command = params[0].substr(1).toLowerCase();
            params = params.splice(1, params.length - 1);
        } else {
            // Default command
            command = 'msg';
            params.unshift(_kiwi.app.panels().active.get('name'));
        }

        // Trigger the command events
        this.trigger('command', {command: command, params: params});
        this.trigger('command:' + command, {command: command, params: params});

        // If we didn't have any listeners for this event, fire a special case
        // TODO: This feels dirty. Should this really be done..?
        if (!this._events['command:' + command]) {
            this.trigger('unknown_command', {command: command, params: params});
        }
    },


    addPluginIcon: function ($icon) {
        var $tool = $('<div class="tool"></div>').append($icon);
        this.$el.find('.input_tools').append($tool);
        _kiwi.app.view.doLayout();
    }
});



_kiwi.view.Favicon = Backbone.View.extend({
    initialize: function () {
        var that = this,
            $win = $(window);

        this.has_focus = true;
        this.highlight_count = 0;
        // Check for html5 canvas support
        this.has_canvas_support = !!window.CanvasRenderingContext2D;

        // Store the original favicon
        this.original_favicon = $('link[rel~="icon"]')[0].href;

        // Create our favicon canvas
        this._createCanvas();

        // Reset favicon notifications when user focuses window
        $win.on('focus', function () {
            that.has_focus = true;
            that._resetHighlights();
        });
        $win.on('blur', function () {
            that.has_focus = false;
        });
    },

    newHighlight: function () {
        var that = this;
        if (!this.has_focus) {
            this.highlight_count++;
            if (this.has_canvas_support) {
                this._drawFavicon(function() {
                    that._drawBubble(that.highlight_count.toString());
                    that._refreshFavicon(that.canvas.toDataURL());
                });
            }
        }
    },

    _resetHighlights: function () {
        var that = this;
        this.highlight_count = 0;
        this._refreshFavicon(this.original_favicon);
    },

    _drawFavicon: function (callback) {
        var that = this,
            canvas = this.canvas,
            context = canvas.getContext('2d'),
            favicon_image = new Image();

        // Allow cross origin resource requests
        favicon_image.crossOrigin = 'anonymous';
        // Trigger the load event
        favicon_image.src = this.original_favicon;

        favicon_image.onload = function() {
            // Clear canvas from prevous iteration
            context.clearRect(0, 0, canvas.width, canvas.height);
            // Draw the favicon itself
            context.drawImage(favicon_image, 0, 0, canvas.width, canvas.height);
            callback();
        };
    },

    _drawBubble: function (label) {
        var letter_spacing,
            bubble_width = 0, bubble_height = 0,
            canvas = this.canvas,
            context = test_context = canvas.getContext('2d'),
            canvas_width = canvas.width,
            canvas_height = canvas.height;

        // Different letter spacing for MacOS 
        if (navigator.appVersion.indexOf("Mac") !== -1) {
            letter_spacing = -1.5;
        }
        else {
            letter_spacing = -1;
        }

        // Setup a test canvas to get text width
        test_context.font = context.font = 'bold 10px Arial';
        test_context.textAlign = 'right';
        this._renderText(test_context, label, 0, 0, letter_spacing);

        // Calculate bubble width based on letter spacing and padding
        bubble_width = test_context.measureText(label).width + letter_spacing * (label.length - 1) + 2;
        // Canvas does not have any way of measuring text height, so we just do it manually and add 1px top/bottom padding
        bubble_height = 9;

        // Set bubble coordinates
        bubbleX = canvas_width - bubble_width;
        bubbleY = canvas_height - bubble_height;

        // Draw bubble background
        context.fillStyle = 'red';
        context.fillRect(bubbleX, bubbleY, bubble_width, bubble_height);

        // Draw the text
        context.fillStyle = 'white';
        this._renderText(context, label, canvas_width - 1, canvas_height - 1, letter_spacing);
    },

    _refreshFavicon: function (url) {
        $('link[rel~="icon"]').remove();
        $('<link rel="shortcut icon" href="' + url + '">').appendTo($('head'));
    },

    _createCanvas: function () {
        var canvas = document.createElement('canvas');
            canvas.width = 16;
            canvas.height = 16;
        
        this.canvas = canvas;
    },

    _renderText: function (context, text, x, y, letter_spacing) {
        // A hacky solution for letter-spacing, but works well with small favicon text
        // Modified from http://jsfiddle.net/davidhong/hKbJ4/
        var current,
            characters = text.split('').reverse(),
            index = 0,
            currentPosition = x;

        while (index < text.length) {
            current = characters[index++];
            context.fillText(current, currentPosition, y);
            currentPosition += (-1 * (context.measureText(current).width + letter_spacing));
        }

        return context;
    }
});



_kiwi.view.MediaMessage = Backbone.View.extend({
    events: {
        'click .media_close': 'close'
    },

    initialize: function () {
        // Get the URL from the data
        this.url = this.$el.data('url');
    },

    toggle: function () {
        if (!this.$content || !this.$content.is(':visible')) {
            this.open();
        } else {
            this.close();
        }
    },

    // Close the media content and remove it from display
    close: function () {
        var that = this;
        this.$content.slideUp('fast', function () {
            that.$content.remove();
        });
    },

    // Open the media content within its wrapper
    open: function () {
        // Create the content div if we haven't already
        if (!this.$content) {
            this.$content = $('<div class="media_content"><a class="media_close"><i class="icon-chevron-up"></i> ' + _kiwi.global.i18n.translate('client_views_mediamessage_close').fetch() + '</a><br /><div class="content"></div></div>');
            this.$content.find('.content').append(this.mediaTypes[this.$el.data('type')].apply(this, []) || _kiwi.global.i18n.translate('client_views_mediamessage_notfound').fetch() + ' :(');
        }

        // Now show the content if not already
        if (!this.$content.is(':visible')) {
            // Hide it first so the slideDown always plays
            this.$content.hide();

            // Add the media content and slide it into view
            this.$el.append(this.$content);
            this.$content.slideDown();
        }
    },



    // Generate the media content for each recognised type
    mediaTypes: {
        twitter: function () {
            var tweet_id = this.$el.data('tweetid');
            var that = this;

            $.getJSON('https://api.twitter.com/1/statuses/oembed.json?id=' + tweet_id + '&callback=?', function (data) {
                that.$content.find('.content').html(data.html);
            });

            return $('<div>' + _kiwi.global.i18n.translate('client_views_mediamessage_load_tweet').fetch() + '...</div>');
        },


        image: function () {
            return $('<a href="' + this.url + '" target="_blank"><img height="100" src="' + this.url + '" /></a>');
        },


        imgur: function () {
            var that = this;

            $.getJSON('http://api.imgur.com/oembed?url=' + this.url, function (data) {
                var img_html = '<a href="' + data.url + '" target="_blank"><img height="100" src="' + data.url + '" /></a>';
                that.$content.find('.content').html(img_html);
            });

            return $('<div>' + _kiwi.global.i18n.translate('client_views_mediamessage_load_image').fetch() + '...</div>');
        },


        reddit: function () {
            var that = this;
            var matches = (/reddit\.com\/r\/([a-zA-Z0-9_\-]+)\/comments\/([a-z0-9]+)\/([^\/]+)?/gi).exec(this.url);

            $.getJSON('http://www.' + matches[0] + '.json?jsonp=?', function (data) {
                console.log('Loaded reddit data', data);
                var post = data[0].data.children[0].data;
                var thumb = '';

                // Show a thumbnail if there is one
                if (post.thumbnail) {
                    //post.thumbnail = 'http://www.eurotunnel.com/uploadedImages/commercial/back-steps-icon-arrow.png';

                    // Hide the thumbnail if an over_18 image
                    if (post.over_18) {
                        thumb = '<span class="thumbnail_nsfw" onclick="$(this).find(\'p\').remove(); $(this).find(\'img\').css(\'visibility\', \'visible\');">';
                        thumb += '<p style="font-size:0.9em;line-height:1.2em;cursor:pointer;">Show<br />NSFW</p>';
                        thumb += '<img src="' + post.thumbnail + '" class="thumbnail" style="visibility:hidden;" />';
                        thumb += '</span>';
                    } else {
                        thumb = '<img src="' + post.thumbnail + '" class="thumbnail" />';
                    }
                }

                // Build the template string up
                var tmpl = '<div>' + thumb + '<b><%- title %></b><br />Posted by <%- author %>. &nbsp;&nbsp; ';
                tmpl += '<i class="icon-arrow-up"></i> <%- ups %> &nbsp;&nbsp; <i class="icon-arrow-down"></i> <%- downs %><br />';
                tmpl += '<%- num_comments %> comments made. <a href="http://www.reddit.com<%- permalink %>">View post</a></div>';

                that.$content.find('.content').html(_.template(tmpl, post));
            });

            return $('<div>' + _kiwi.global.i18n.translate('client_views_mediamessage_load_reddit').fetch() + '...</div>');
        },


        youtube: function () {
            var ytid = this.$el.data('ytid');
            var that = this;
            var yt_html = '<iframe width="480" height="270" src="https://www.youtube.com/embed/'+ ytid +'?feature=oembed" frameborder="0" allowfullscreen=""></iframe>';
            that.$content.find('.content').html(yt_html);

            return $('');
        },


        gist: function () {
            var that = this,
                matches = (/https?:\/\/gist\.github\.com\/(?:[a-z0-9-]*\/)?([a-z0-9]+)(\#(.+))?$/i).exec(this.url);

            $.getJSON('https://gist.github.com/'+matches[1]+'.json?callback=?' + (matches[2] || ''), function (data) {
                $('body').append('<link rel="stylesheet" href="' + data.stylesheet + '" type="text/css" />');
                that.$content.find('.content').html(data.div);
            });

            return $('<div>' + _kiwi.global.i18n.translate('client_views_mediamessage_load_gist').fetch() + '...</div>');
        }
    }
    }, {

    // Build the closed media HTML from a URL
    buildHtml: function (url) {
        var html = '', matches;

        // Is it an image?
        if (url.match(/(\.jpe?g|\.gif|\.bmp|\.png)\??$/i)) {
            html += '<span class="media image" data-type="image" data-url="' + url + '" title="Open Image"><a class="open"><i class="icon-chevron-right"></i></a></span>';
        }

        // Is this an imgur link not picked up by the images regex?
        matches = (/imgur\.com\/[^/]*(?!=\.[^!.]+($|\?))/ig).exec(url);
        if (matches && !url.match(/(\.jpe?g|\.gif|\.bmp|\.png)\??$/i)) {
            html += '<span class="media imgur" data-type="imgur" data-url="' + url + '" title="Open Image"><a class="open"><i class="icon-chevron-right"></i></a></span>';
        }

        // Is it a tweet?
        matches = (/https?:\/\/twitter.com\/([a-zA-Z0-9_]+)\/status\/([0-9]+)/ig).exec(url);
        if (matches) {
            html += '<span class="media twitter" data-type="twitter" data-url="' + url + '" data-tweetid="' + matches[2] + '" title="Show tweet information"><a class="open"><i class="icon-chevron-right"></i></a></span>';
        }

        // Is reddit?
        matches = (/reddit\.com\/r\/([a-zA-Z0-9_\-]+)\/comments\/([a-z0-9]+)\/([^\/]+)?/gi).exec(url);
        if (matches) {
            html += '<span class="media reddit" data-type="reddit" data-url="' + url + '" title="Reddit thread"><a class="open"><i class="icon-chevron-right"></i></a></span>';
        }

        // Is youtube?
        matches = (/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/ ]{11})/gi).exec(url);
        if (matches) {
            html += '<span class="media youtube" data-type="youtube" data-url="' + url + '" data-ytid="' + matches[1] + '" title="YouTube Video"><a class="open"><i class="icon-chevron-right"></i></a></span>';
        }

        // Is a github gist?
        matches = (/https?:\/\/gist\.github\.com\/(?:[a-z0-9-]*\/)?([a-z0-9]+)(\#(.+))?$/i).exec(url);
        if (matches) {
            html += '<span class="media gist" data-type="gist" data-url="' + url + '" data-gist_id="' + matches[1] + '" title="GitHub Gist"><a class="open"><i class="icon-chevron-right"></i></a></span>';
        }

        return html;
    }
});



_kiwi.view.Member = Backbone.View.extend({
    tagName: "li",
    initialize: function (options) {
        this.model.bind('change', this.render, this);
        this.render();
    },
    render: function () {
        var $this = this.$el,
            prefix_css_class = (this.model.get('modes') || []).join(' ');

        $this.attr('class', 'mode ' + prefix_css_class);
        $this.html('<a class="nick"><span class="prefix">' + this.model.get("prefix") + '</span>' + this.model.get("nick") + '</a>');

        return this;
    }
});


_kiwi.view.MemberList = Backbone.View.extend({
    tagName: "ul",
    events: {
        "click .nick": "nickClick"
    },
    initialize: function (options) {
        this.model.bind('all', this.render, this);
        $(this.el).appendTo('#kiwi .memberlists');
    },
    render: function () {
        var $this = this.$el;
        $this.empty();
        this.model.forEach(function (member) {
            member.view.$el.data('member', member);
            $this.append(member.view.$el);
        });
        return this;
    },
    nickClick: function (event) {
        var $target = $(event.currentTarget).parent('li'),
            member = $target.data('member'),
            userbox;

        userbox = new _kiwi.view.UserBox();
        userbox.member = member;
        userbox.channel = this.model.channel;

        if (!this.model.getByNick(_kiwi.app.connections.active_connection.get('nick')).get('is_op')) {
            userbox.$el.children('.if_op').remove();
        }

        var menu = new _kiwi.view.MenuBox(member.get('nick') || 'User');
        menu.addItem('userbox', userbox.$el);
        menu.show();

        // Position the userbox + menubox
        (function() {
            var t = event.pageY,
                m_bottom = t + menu.$el.outerHeight(),  // Where the bottom of menu will be
                memberlist_bottom = this.$el.parent().offset().top + this.$el.parent().outerHeight(),
                l = event.pageX,
                m_right = l + menu.$el.outerWidth(),  // Where the left of menu will be
                memberlist_right = this.$el.parent().offset().left + this.$el.parent().outerWidth();

            // If the bottom of the userbox is going to be too low.. raise it
            if (m_bottom > memberlist_bottom){
                t = memberlist_bottom - menu.$el.outerHeight();
            }

            // If the right of the userbox is going off screen.. bring it in
            if (m_right > memberlist_right){
                l = memberlist_right - menu.$el.outerWidth();
            }

            // Set the new positon
            menu.$el.offset({
                left: l,
                top: t
            });
        }).call(this);
    },
    show: function () {
        $('#kiwi .memberlists').children().removeClass('active');
        $(this.el).addClass('active');
    }
});


_kiwi.view.MenuBox = Backbone.View.extend({
    events: {
        'click .ui_menu_foot .close, a.close_menu': 'dispose'
    },

    initialize: function(title) {
        var that = this;

        this.$el = $('<div class="ui_menu"></div>');

        this._title = title || '';
        this._items = {};
        this._display_footer = true;
        this._close_on_blur = true;
    },


    render: function() {
        var that = this;

        this.$el.find('*').remove();

        if (this._title) {
            $('<div class="ui_menu_title"></div>')
                .text(this._title)
                .appendTo(this.$el);
        }


        _.each(this._items, function(item) {
            var $item = $('<div class="ui_menu_content hover"></div>')
                .append(item);

            that.$el.append($item);
        });

        if (this._display_footer)
            this.$el.append('<div class="ui_menu_foot"><a class="close" onclick="">Close <i class="icon-remove"></i></a></div>');
    },


    onDocumentClick: function(event) {
        var $target = $(event.target);

        if (!this._close_on_blur)
            return;

        // If this is not itself AND we don't contain this element, dispose $el
        if ($target[0] != this.$el[0] && this.$el.has($target).length === 0)
            this.dispose();
    },


    dispose: function() {
        _.each(this._items, function(item) {
            item.dispose && item.dispose();
            item.remove && item.remove();
        });

        this._items = null;
        this.remove();

        if (this._close_proxy)
            $(document).off('click', this._close_proxy);
    },


    addItem: function(item_name, $item) {
        $item = $($item);
        if ($item.is('a')) $item.addClass('icon-chevron-right');
        this._items[item_name] = $item;
    },


    removeItem: function(item_name) {
        delete this._items[item_name];
    },


    showFooter: function(show) {
        this._display_footer = show;
    },


    closeOnBlur: function(close_it) {
        this._close_on_blur = close_it;
    },


    show: function() {
        var that = this;

        this.render();
        this.$el.appendTo(_kiwi.app.view.$el);

        // We add this document click listener on the next javascript tick.
        // If the current tick is handling an existing click event (such as the nicklist click handler),
        // the click event bubbles up and hits the document therefore calling this callback to
        // remove this menubox before it's even shown.
        setTimeout(function() {
            that._close_proxy = function(event) {
                that.onDocumentClick(event);
            };
            $(document).on('click', that._close_proxy);
        }, 0);
    }
});



// Model for this = _kiwi.model.NetworkPanelList
_kiwi.view.NetworkTabs = Backbone.View.extend({
    tagName: 'ul',
    className: 'connections',

    initialize: function() {
        this.model.on('add', this.networkAdded, this);
        this.model.on('remove', this.networkRemoved, this);

        this.$el.appendTo(_kiwi.app.view.$el.find('.tabs'));
    },

    networkAdded: function(network) {
        $('<li class="connection"></li>')
            .append(network.panels.view.$el)
            .appendTo(this.$el);
    },

    networkRemoved: function(network) {
        network.panels.view.remove();

        _kiwi.app.view.doLayout();
    }
});


_kiwi.view.NickChangeBox = Backbone.View.extend({
    events: {
        'submit': 'changeNick',
        'click .cancel': 'close'
    },

    initialize: function () {
        var text = {
            new_nick: _kiwi.global.i18n.translate('client_views_nickchangebox_new').fetch(),
            change: _kiwi.global.i18n.translate('client_views_nickchangebox_change').fetch(),
            cancel: _kiwi.global.i18n.translate('client_views_nickchangebox_cancel').fetch()
        };
        this.$el = $(_.template($('#tmpl_nickchange').html().trim(), text));
    },

    render: function () {
        // Add the UI component and give it focus
        _kiwi.app.controlbox.$el.prepend(this.$el);
        this.$el.find('input').focus();

        this.$el.css('bottom', _kiwi.app.controlbox.$el.outerHeight(true));
    },
    
    close: function () {
        this.$el.remove();

    },

    changeNick: function (event) {
        var that = this;

        event.preventDefault();

        _kiwi.app.connections.active_connection.gateway.changeNick(this.$el.find('input').val(), function (err, val) {
            that.close();
        });
        return false;
    }
});


_kiwi.view.ResizeHandler = Backbone.View.extend({
    events: {
        'mousedown': 'startDrag',
        'mouseup': 'stopDrag'
    },

    initialize: function () {
        this.dragging = false;
        this.starting_width = {};

        $(window).on('mousemove', $.proxy(this.onDrag, this));
    },

    startDrag: function (event) {
        this.dragging = true;
    },

    stopDrag: function (event) {
        this.dragging = false;
    },

    onDrag: function (event) {
        if (!this.dragging) return;

        this.$el.css('left', event.clientX - (this.$el.outerWidth(true) / 2));
        $('#kiwi .memberlists').css('width', this.$el.parent().width() - (this.$el.position().left + this.$el.outerWidth()));
        _kiwi.app.view.doLayout();
    }
});


_kiwi.view.ServerSelect = function () {
    // Are currently showing all the controlls or just a nick_change box?
    var state = 'all';

    var model = Backbone.View.extend({
        events: {
            'submit form': 'submitForm',
            'click .show_more': 'showMore',
            'change .have_pass input': 'showPass',
            'change .have_key input': 'showKey',
            'click .icon-key': 'channelKeyIconClick'
        },

        initialize: function () {
            var that = this,
                text = {
                    think_nick: _kiwi.global.i18n.translate('client_views_serverselect_form_title').fetch(),
                    nickname: _kiwi.global.i18n.translate('client_views_serverselect_nickname').fetch(),
                    have_password: _kiwi.global.i18n.translate('client_views_serverselect_enable_password').fetch(),
                    password: _kiwi.global.i18n.translate('client_views_serverselect_password').fetch(),
                    channel: _kiwi.global.i18n.translate('client_views_serverselect_channel').fetch(),
                    channel_key: _kiwi.global.i18n.translate('client_views_serverselect_channelkey').fetch(),
                    require_key: _kiwi.global.i18n.translate('client_views_serverselect_channelkey_required').fetch(),
                    key: _kiwi.global.i18n.translate('client_views_serverselect_key').fetch(),
                    start: _kiwi.global.i18n.translate('client_views_serverselect_connection_start').fetch(),
                    server_network: _kiwi.global.i18n.translate('client_views_serverselect_server_and_network').fetch(),
                    server: _kiwi.global.i18n.translate('client_views_serverselect_server').fetch(),
                    port: _kiwi.global.i18n.translate('client_views_serverselect_port').fetch(),
                    powered_by: _kiwi.global.i18n.translate('client_views_serverselect_poweredby').fetch()
                };

            this.$el = $(_.template($('#tmpl_server_select').html().trim(), text));

            // Remove the 'more' link if the server has disabled server changing
            if (_kiwi.app.server_settings && _kiwi.app.server_settings.connection) {
                if (!_kiwi.app.server_settings.connection.allow_change) {
                    this.$el.find('.show_more').remove();
                    this.$el.addClass('single_server');
                }
            }

            this.more_shown = false;

            _kiwi.gateway.bind('onconnect', this.networkConnected, this);
            _kiwi.gateway.bind('connecting', this.networkConnecting, this);
            _kiwi.gateway.bind('onirc_error', this.onIrcError, this);
        },

        dispose: function() {
            _kiwi.gateway.off('onconnect', this.networkConnected, this);
            _kiwi.gateway.off('connecting', this.networkConnecting, this);
            _kiwi.gateway.off('onirc_error', this.onIrcError, this);

            this.$el.remove();
        },

        submitForm: function (event) {
            event.preventDefault();

            // Make sure a nick is chosen
            if (!$('input.nick', this.$el).val().trim()) {
                this.setStatus(_kiwi.global.i18n.translate('client_views_serverselect_nickname_error_empty').fetch());
                $('input.nick', this.$el).select();
                return;
            }

            if (state === 'nick_change') {
                this.submitNickChange(event);
            } else {
                this.submitLogin(event);
            }

            $('button', this.$el).attr('disabled', 1);
            return;
        },

        submitLogin: function (event) {
            // If submitting is disabled, don't do anything
            if ($('button', this.$el).attr('disabled')) return;

            var values = {
                nick: $('input.nick', this.$el).val(),
                server: $('input.server', this.$el).val(),
                port: $('input.port', this.$el).val(),
                ssl: $('input.ssl', this.$el).prop('checked'),
                password: $('input.password', this.$el).val(),
                channel: $('input.channel', this.$el).val(),
                channel_key: $('input.channel_key', this.$el).val(),
                options: this.server_options
            };

            this.trigger('server_connect', values);
        },

        submitNickChange: function (event) {
            _kiwi.gateway.changeNick(null, $('input.nick', this.$el).val());
            this.networkConnecting();
        },

        showPass: function (event) {
            if (this.$el.find('tr.have_pass input').is(':checked')) {
                this.$el.find('tr.pass').show().find('input').focus();
            } else {
                this.$el.find('tr.pass').hide().find('input').val('');
            }
        },

        channelKeyIconClick: function (event) {
            this.$el.find('tr.have_key input').click();
        },

        showKey: function (event) {
            if (this.$el.find('tr.have_key input').is(':checked')) {
                this.$el.find('tr.key').show().find('input').focus();
            } else {
                this.$el.find('tr.key').hide().find('input').val('');
            }
        },

        showMore: function (event) {
            if (!this.more_shown) {
                $('.more', this.$el).slideDown('fast');
                $('.show_more', this.$el)
                    .children('.icon-caret-down')
                    .removeClass('icon-caret-down')
                    .addClass('icon-caret-up');
                $('input.server', this.$el).select();
                this.more_shown = true;
            } else {
                $('.more', this.$el).slideUp('fast');
                $('.show_more', this.$el)
                    .children('.icon-caret-up')
                    .removeClass('icon-caret-up')
                    .addClass('icon-caret-down');
                $('input.nick', this.$el).select();
                this.more_shown = false;
            }
        },

        populateFields: function (defaults) {
            var nick, server, port, channel, channel_key, ssl, password;

            defaults = defaults || {};

            nick = defaults.nick || '';
            server = defaults.server || '';
            port = defaults.port || 6667;
            ssl = defaults.ssl || 0;
            password = defaults.password || '';
            channel = defaults.channel || '';
            channel_key = defaults.channel_key || '';

            $('input.nick', this.$el).val(nick);
            $('input.server', this.$el).val(server);
            $('input.port', this.$el).val(port);
            $('input.ssl', this.$el).prop('checked', ssl);
            $('input#server_select_show_pass', this.$el).prop('checked', !(!password));
            $('input.password', this.$el).val(password);
            if (!(!password)) {
                $('tr.pass', this.$el).show();
            }
            $('input.channel', this.$el).val(channel);
            $('input#server_select_show_channel_key', this.$el).prop('checked', !(!channel_key));
            $('input.channel_key', this.$el).val(channel_key);
            if (!(!channel_key)) {
                $('tr.key', this.$el).show();
            }

            // Temporary values
            this.server_options = {};

            if (defaults.encoding)
                this.server_options.encoding = defaults.encoding;
        },

        hide: function () {
            this.$el.slideUp();
        },

        show: function (new_state) {
            new_state = new_state || 'all';

            this.$el.show();

            if (new_state === 'all') {
                $('.show_more', this.$el).show();

            } else if (new_state === 'more') {
                $('.more', this.$el).slideDown('fast');

            } else if (new_state === 'nick_change') {
                $('.more', this.$el).hide();
                $('.show_more', this.$el).hide();
                $('input.nick', this.$el).select();

            } else if (new_state === 'enter_password') {
                $('.more', this.$el).hide();
                $('.show_more', this.$el).hide();
                $('input.password', this.$el).select();
            }

            state = new_state;
        },

        infoBoxShow: function() {
            var $side_panel = this.$el.find('.side_panel');

            // Some theme may hide the info panel so check before we
            // resize ourselves
            if (!$side_panel.is(':visible'))
                return;

            this.$el.animate({
                width: parseInt($side_panel.css('left'), 10) + $side_panel.find('.content:first').outerWidth()
            });
        },

        infoBoxHide: function() {
            var $side_panel = this.$el.find('.side_panel');
            this.$el.animate({
                width: parseInt($side_panel.css('left'), 10)
            });
        },

        infoBoxSet: function($info_view) {
            this.$el.find('.side_panel .content')
                .empty()
                .append($info_view);
        },

        setStatus: function (text, class_name) {
            $('.status', this.$el)
                .text(text)
                .attr('class', 'status')
                .addClass(class_name||'')
                .show();
        },
        clearStatus: function () {
            $('.status', this.$el).hide();
        },

        networkConnected: function (event) {
            this.setStatus(_kiwi.global.i18n.translate('client_views_serverselect_connection_successfully').fetch() + ' :)', 'ok');
            $('form', this.$el).hide();
        },

        networkConnecting: function (event) {
            this.setStatus(_kiwi.global.i18n.translate('client_views_serverselect_connection_trying').fetch(), 'ok');
        },

        onIrcError: function (data) {
            $('button', this.$el).attr('disabled', null);

            switch(data.error) {
            case 'nickname_in_use':
                this.setStatus(_kiwi.global.i18n.translate('client_views_serverselect_nickname_error_alreadyinuse').fetch());
                this.show('nick_change');
                this.$el.find('.nick').select();
                break;
            case 'erroneus_nickname':
                this.setStatus(_kiwi.global.i18n.translate('client_views_serverselect_nickname_invalid').fetch());
                this.show('nick_change');
                this.$el.find('.nick').select();
                break;
            case 'password_mismatch':
                this.setStatus(_kiwi.global.i18n.translate('client_views_serverselect_password_incorrect').fetch());
                this.show('enter_password');
                this.$el.find('.password').select();
                break;
            }
        },

        showError: function (error_reason) {
            var err_text = _kiwi.global.i18n.translate('client_views_serverselect_connection_error').fetch();

            if (error_reason) {
                switch (error_reason) {
                case 'ENOTFOUND':
                    err_text = _kiwi.global.i18n.translate('client_views_serverselect_server_notfound').fetch();
                    break;

                case 'ECONNREFUSED':
                    err_text += ' (' + _kiwi.global.i18n.translate('client_views_serverselect_connection_refused').fetch() + ')';
                    break;

                default:
                    err_text += ' (' + error_reason + ')';
                }
            }

            this.setStatus(err_text, 'error');
            $('button', this.$el).attr('disabled', null);
            this.show();
        }
    });


    return new model(arguments);
};


_kiwi.view.StatusMessage = Backbone.View.extend({
    initialize: function () {
        this.$el.hide();

        // Timer for hiding the message after X seconds
        this.tmr = null;
    },

    text: function (text, opt) {
        // Defaults
        opt = opt || {};
        opt.type = opt.type || '';
        opt.timeout = opt.timeout || 5000;

        this.$el.text(text).addClass(opt.type);
        this.$el.slideDown($.proxy(_kiwi.app.view.doLayout, _kiwi.app.view));

        if (opt.timeout) this.doTimeout(opt.timeout);
    },

    html: function (html, opt) {
        // Defaults
        opt = opt || {};
        opt.type = opt.type || '';
        opt.timeout = opt.timeout || 5000;

        this.$el.html(html).addClass(opt.type);
        this.$el.slideDown($.proxy(_kiwi.app.view.doLayout, _kiwi.app.view));

        if (opt.timeout) this.doTimeout(opt.timeout);
    },

    hide: function () {
        this.$el.slideUp($.proxy(_kiwi.app.view.doLayout, _kiwi.app.view));
    },

    doTimeout: function (length) {
        if (this.tmr) clearTimeout(this.tmr);
        var that = this;
        this.tmr = setTimeout(function () { that.hide(); }, length);
    }
});


// Model for this = _kiwi.model.PanelList
_kiwi.view.Tabs = Backbone.View.extend({
    tagName: 'ul',
    className: 'panellist',

    events: {
        'click li': 'tabClick',
        'click li .part': 'partClick'
    },

    initialize: function () {
        this.model.on("add", this.panelAdded, this);
        this.model.on("remove", this.panelRemoved, this);
        this.model.on("reset", this.render, this);

        this.model.on('active', this.panelActive, this);

        // Network tabs start with a server, so determine what we are now
        this.is_network = false;

        if (this.model.network) {
            this.is_network = true;

            this.model.network.on('change:name', function (network, new_val) {
                $('span', this.model.server.tab).text(new_val);
            }, this);
        }
    },

    render: function () {
        var that = this;

        this.$el.empty();
        
        if (this.is_network) {
            // Add the server tab first
            this.model.server.tab
                .data('panel', this.model.server)
                .data('connection_id', this.model.network.get('connection_id'))
                .appendTo(this.$el);
        }

        // Go through each panel adding its tab
        this.model.forEach(function (panel) {
            // If this is the server panel, ignore as it's already added
            if (this.is_network && panel == that.model.server)
                return;

            panel.tab.data('panel', panel);

            if (this.is_network)
                panel.tab.data('connection_id', this.model.network.get('connection_id'));

            panel.tab.appendTo(that.$el);
        });

        _kiwi.app.view.doLayout();
    },

    updateTabTitle: function (panel, new_title) {
        $('span', panel.tab).text(new_title);
    },

    panelAdded: function (panel) {
        // Add a tab to the panel
        panel.tab = $('<li><span>' + (panel.get('title') || panel.get('name')) + '</span><div class="activity"></div></li>');

        if (panel.isServer()) {
            panel.tab.addClass('server');
            panel.tab.addClass('icon-nonexistant');
        }

        panel.tab.data('panel', panel);

        if (this.is_network)
            panel.tab.data('connection_id', this.model.network.get('connection_id'));

        panel.tab.appendTo(this.$el);

        panel.bind('change:title', this.updateTabTitle);
        panel.bind('change:name', this.updateTabTitle);

        _kiwi.app.view.doLayout();
    },
    panelRemoved: function (panel) {
        panel.tab.remove();
        delete panel.tab;

        _kiwi.app.view.doLayout();
    },

    panelActive: function (panel, previously_active_panel) {
        // Remove any existing tabs or part images
        _kiwi.app.view.$el.find('.panellist .part').remove();
        _kiwi.app.view.$el.find('.panellist .active').removeClass('active');

        panel.tab.addClass('active');

        // Only show the part image on non-server tabs
        if (!panel.isServer()) {
            panel.tab.append('<span class="part icon-nonexistant"></span>');
        }
    },

    tabClick: function (e) {
        var tab = $(e.currentTarget);

        var panel = tab.data('panel');
        if (!panel) {
            // A panel wasn't found for this tab... wadda fuck
            return;
        }

        panel.view.show();
    },

    partClick: function (e) {
        var tab = $(e.currentTarget).parent();
        var panel = tab.data('panel');

        if (!panel) return;

        // Only need to part if it's a channel
        // If the nicklist is empty, we haven't joined the channel as yet
        if (panel.isChannel() && panel.get('members').models.length > 0) {
            this.model.network.gateway.part(panel.get('name'));
        } else {
            panel.close();
        }
    }
});


_kiwi.view.TopicBar = Backbone.View.extend({
    events: {
        'keydown div': 'process'
    },

    initialize: function () {
        _kiwi.app.panels.bind('active', function (active_panel) {
            // If it's a channel topic, update and make editable
            if (active_panel.isChannel()) {
                this.setCurrentTopic(active_panel.get('topic') || '');
                this.$el.find('div').attr('contentEditable', true);

            } else {
                // Not a channel topic.. clear and make uneditable
                this.$el.find('div').attr('contentEditable', false)
                    .text('');
            }
        }, this);
    },

    process: function (ev) {
        var inp = $(ev.currentTarget),
            inp_val = inp.text();
        
        // Only allow topic editing if this is a channel panel
        if (!_kiwi.app.panels().active.isChannel()) {
            return false;
        }

        // If hit return key, update the current topic
        if (ev.keyCode === 13) {
            _kiwi.gateway.topic(null, _kiwi.app.panels().active.get('name'), inp_val);
            return false;
        }
    },

    setCurrentTopic: function (new_topic) {
        new_topic = new_topic || '';

        // We only want a plain text version
        $('div', this.$el).html(formatIRCMsg(_.escape(new_topic)));
    }
});


_kiwi.view.UserBox = Backbone.View.extend({
    events: {
        'click .query': 'queryClick',
        'click .info': 'infoClick',
        'click .slap': 'slapClick',
        'click .op': 'opClick',
        'click .deop': 'deopClick',
        'click .voice': 'voiceClick',
        'click .devoice': 'devoiceClick',
        'click .kick': 'kickClick',
        'click .ban': 'banClick'
    },

    initialize: function () {
        var text = {
            op: _kiwi.global.i18n.translate('client_views_userbox_op').fetch(),
            de_op: _kiwi.global.i18n.translate('client_views_userbox_deop').fetch(),
            voice: _kiwi.global.i18n.translate('client_views_userbox_voice').fetch(),
            de_voice: _kiwi.global.i18n.translate('client_views_userbox_devoice').fetch(),
            kick: _kiwi.global.i18n.translate('client_views_userbox_kick').fetch(),
            ban: _kiwi.global.i18n.translate('client_views_userbox_ban').fetch(),
            message: _kiwi.global.i18n.translate('client_views_userbox_query').fetch(),
            info: _kiwi.global.i18n.translate('client_views_userbox_whois').fetch(),
            slap: _kiwi.global.i18n.translate('client_views_userbox_slap').fetch()
        };
        this.$el = $(_.template($('#tmpl_userbox').html().trim(), text));
    },

    queryClick: function (event) {
        var panel = new _kiwi.model.Query({name: this.member.get('nick')});
        _kiwi.app.connections.active_connection.panels.add(panel);
        panel.view.show();
    },

    infoClick: function (event) {
        _kiwi.app.controlbox.processInput('/whois ' + this.member.get('nick'));
    },

    slapClick: function (event) {
        _kiwi.app.controlbox.processInput('/slap ' + this.member.get('nick'));
    },

    opClick: function (event) {
        _kiwi.app.controlbox.processInput('/mode ' + this.channel.get('name') + ' +o ' + this.member.get('nick'));
    },

    deopClick: function (event) {
        _kiwi.app.controlbox.processInput('/mode ' + this.channel.get('name') + ' -o ' + this.member.get('nick'));
    },

    voiceClick: function (event) {
        _kiwi.app.controlbox.processInput('/mode ' + this.channel.get('name') + ' +v ' + this.member.get('nick'));
    },

    devoiceClick: function (event) {
        _kiwi.app.controlbox.processInput('/mode ' + this.channel.get('name') + ' -v ' + this.member.get('nick'));
    },

    kickClick: function (event) {
        // TODO: Enable the use of a custom kick message
        _kiwi.app.controlbox.processInput('/kick ' + this.member.get('nick') + ' Bye!');
    },

    banClick: function (event) {
        // TODO: Set ban on host, not just on nick
        _kiwi.app.controlbox.processInput('/mode ' + this.channel.get('name') + ' +b ' + this.member.get('nick') + '!*');
    }
});



})(window);