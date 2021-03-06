
if (!Elm.fullscreen) {

    (function() {
        'use strict';

        var Display = { FULLSCREEN: 0, COMPONENT: 1, NONE: 2 };

        Elm.fullscreen = function(module, ports) {
            var container = document.createElement('div');
            document.body.appendChild(container);
            return init(Display.FULLSCREEN, container, module, ports || {});
        };

        Elm.embed = function(module, container, ports) {
            var tag = container.tagName;
            if (tag !== 'DIV') {
                throw new Error('Elm.node must be given a DIV, not a ' + tag + '.');
            } else if (container.hasChildNodes()) {
                throw new Error('Elm.node must be given an empty DIV. No children allowed!');
            }
            return init(Display.COMPONENT, container, module, ports || {});
        };

        Elm.worker = function(module, ports) {
            return init(Display.NONE, {}, module, ports || {});
        };

        function init(display, container, module, ports, moduleToReplace) {
          // defining state needed for an instance of the Elm RTS
          var inputs = [];

          /* OFFSET
           * Elm's time traveling debugger lets you interrupt the smooth flow of time
           * by pausing and continuing program execution. To ensure the user sees a
           * program that moves smoothly through the pause/continue time gap,
           * we need to adjsut the value of Date.now().
           */
          var timer = function() {
            var inducedDelay = 0;

            var now = function() {
              return Date.now() - inducedDelay;
            };

            var addDelay = function(d) {
              inducedDelay += d;
              return inducedDelay;
            };

            return { now : now
                   , addDelay : addDelay
                   }
          }();

          var updateInProgress = false;
          function notify(id, v) {
              if (updateInProgress) {
                  throw new Error(
                      'The notify function has been called synchronously!\n' +
                      'This can lead to frames being dropped.\n' +
                      'Definitely report this to <https://github.com/elm-lang/Elm/issues>\n');
              }
              updateInProgress = true;
              var timestep = timer.now();
              for (var i = inputs.length; i--; ) {
                  inputs[i].recv(timestep, id, v);
              }
              updateInProgress = false;
          }
          function setTimeout(func, delay) {
            window.setTimeout(func, delay);
          }

          var listeners = [];
          function addListener(relevantInputs, domNode, eventName, func) {
              domNode.addEventListener(eventName, func);
              var listener = {
                  relevantInputs: relevantInputs,
                  domNode: domNode,
                  eventName: eventName,
                  func: func
              };
              listeners.push(listener);
          }

          var portUses = {}
          for (var key in ports) {
              portUses[key] = 0;
          }
          // create the actual RTS. Any impure modules will attach themselves to this
          // object. This permits many Elm programs to be embedded per document.
          var elm = {
              notify: notify,
              setTimeout: setTimeout,
              node: container,
              addListener: addListener,
              inputs: inputs,
              timer: timer,
              ports: { incoming:ports, outgoing:{}, uses:portUses },

              isFullscreen: function() { return display === Display.FULLSCREEN; },
              isEmbed: function() { return display === Display.COMPONENT; },
              isWorker: function() { return display === Display.NONE; }
          };

          function swap(newModule) {
              removeListeners(listeners);
              var div = document.createElement('div');
              var newElm = init(display, div, newModule, ports, elm);
              inputs = [];
              // elm.swap = newElm.swap;
              return newElm;
          }

          function dispose() {
            removeListeners(listeners);
            inputs = [];
          }

          var Module = {};
          try {
              Module = module.make(elm);
              checkPorts(elm);
          } catch(e) {
              var code = document.createElement('code');

              var lines = e.message.split('\n');
              code.appendChild(document.createTextNode(lines[0]));
              code.appendChild(document.createElement('br'));
              code.appendChild(document.createElement('br'));
              for (var i = 1; i < lines.length; ++i) {
                  code.appendChild(document.createTextNode('\u00A0 \u00A0 ' + lines[i]));
                  code.appendChild(document.createElement('br'));
              }
              code.appendChild(document.createElement('br'));
              code.appendChild(document.createTextNode("Open the developer console for more details."));

              container.appendChild(code);
              throw e;
          }
          inputs = filterDeadInputs(inputs);
          filterListeners(inputs, listeners);
          addReceivers(elm.ports.outgoing);
          if (display !== Display.NONE) {
              var graphicsNode = initGraphics(elm, Module);
          }
          if (typeof moduleToReplace !== 'undefined') {
              hotSwap(moduleToReplace, elm);

              // rerender scene if graphics are enabled.
              if (typeof graphicsNode !== 'undefined') {
                  graphicsNode.recv(0, true, 0);
              }
          }

          return {
            swap:swap,
            ports:elm.ports.outgoing,
            dispose:dispose
          };
        };

        function checkPorts(elm) {
            var portUses = elm.ports.uses;
            for (var key in portUses) {
                var uses = portUses[key]
                if (uses === 0) {
                    throw new Error(
                        "Initialization Error: provided port '" + key +
                        "' to a module that does not take it as in input.\n" +
                        "Remove '" + key + "' from the module initialization code.");
                } else if (uses > 1) {
                    throw new Error(
                        "Initialization Error: port '" + key +
                        "' has been declared multiple times in the Elm code.\n" +
                        "Remove declarations until there is exactly one.");
                }
            }
        }


        //// FILTER SIGNALS ////

        // TODO: move this code into the signal module and create a function
        // Signal.initializeGraph that actually instantiates everything.

        function filterListeners(inputs, listeners) {
            loop:
            for (var i = listeners.length; i--; ) {
                var listener = listeners[i];
                for (var j = inputs.length; j--; ) {
                    if (listener.relevantInputs.indexOf(inputs[j].id) >= 0) {
                        continue loop;
                    }
                }
                listener.domNode.removeEventListener(listener.eventName, listener.func);
            }
        }

        function removeListeners(listeners) {
            for (var i = listeners.length; i--; ) {
                var listener = listeners[i];
                listener.domNode.removeEventListener(listener.eventName, listener.func);
            }
        }

        // add receivers for built-in ports if they are defined
        function addReceivers(ports) {
            if ('log' in ports) {
                ports.log.subscribe(function(v) { console.log(v) });
            }
            if ('stdout' in ports) {
                var process = process || {};
                var handler = process.stdout
                    ? function(v) { process.stdout.write(v); }
                    : function(v) { console.log(v); };
                ports.stdout.subscribe(handler);
            }
            if ('stderr' in ports) {
                var process = process || {};
                var handler = process.stderr
                    ? function(v) { process.stderr.write(v); }
                    : function(v) { console.log('Error:' + v); };
                ports.stderr.subscribe(handler);
            }
            if ('title' in ports) {
                if (typeof ports.title === 'string') {
                    document.title = ports.title;
                } else {
                    ports.title.subscribe(function(v) { document.title = v; });
                }
            }
            if ('redirect' in ports) {
                ports.redirect.subscribe(function(v) {
                    if (v.length > 0) window.location = v;
                });
            }
            if ('favicon' in ports) {
                if (typeof ports.favicon === 'string') {
                    changeFavicon(ports.favicon);
                } else {
                    ports.favicon.subscribe(changeFavicon);
                }
            }
            function changeFavicon(src) {
                var link = document.createElement('link');
                var oldLink = document.getElementById('elm-favicon');
                link.id = 'elm-favicon';
                link.rel = 'shortcut icon';
                link.href = src;
                if (oldLink) {
                    document.head.removeChild(oldLink);
                }
                document.head.appendChild(link);
            }
        }


        function filterDeadInputs(inputs) {
            var temp = [];
            for (var i = inputs.length; i--; ) {
                if (isAlive(inputs[i])) temp.push(inputs[i]);
            }
            return temp;
        }


        function isAlive(input) {
            if (!('defaultNumberOfKids' in input)) return true;
            var len = input.kids.length;
            if (len === 0) return false;
            if (len > input.defaultNumberOfKids) return true;
            var alive = false;
            for (var i = len; i--; ) {
                alive = alive || isAlive(input.kids[i]);
            }
            return alive;
        }


        ////  RENDERING  ////

        function initGraphics(elm, Module) {
          if (!('main' in Module)) {
              throw new Error("'main' is missing! What do I display?!");
          }

          var signalGraph = Module.main;

          // make sure the signal graph is actually a signal & extract the visual model
          var Signal = Elm.Signal.make(elm);
          if (!('recv' in signalGraph)) {
              signalGraph = Signal.constant(signalGraph);
          }
          var currentScene = signalGraph.value;

         // Add the currentScene to the DOM
          var Element = Elm.Native.Graphics.Element.make(elm);
          elm.node.appendChild(Element.render(currentScene));

          // set up updates so that the DOM is adjusted as necessary.
          var savedScene = currentScene;
          var previousDrawId = 0;
          function domUpdate(newScene) {
              previousDrawId = draw(previousDrawId, function(_) {
                  Element.updateAndReplace(elm.node.firstChild, savedScene, newScene);
                  if (elm.Native.Window) {
                      elm.Native.Window.values.resizeIfNeeded();
                  }
                  savedScene = newScene;
              });
          }
          var renderer = A2(Signal.map, domUpdate, signalGraph);

          // must check for resize after 'renderer' is created so
          // that changes show up.
          if (elm.Native.Window) {
              elm.Native.Window.values.resizeIfNeeded();
          }

          return renderer;
        }


        // define function for drawing efficiently
        //
        //   draw : RequestID -> (() -> ()) -> RequestID
        //
        // Takes a "RequestID" allowing you to cancel old requests if possible.
        // Returns a "RequestID" so you can refer to past requests.
        //
        function draw(previousRequestID, callback) {
            callback();
            return previousRequestID;
        }

        var vendors = ['ms', 'moz', 'webkit', 'o'];
        var win = typeof window !== 'undefined' ? window : {};
        for (var i = 0; i < vendors.length && !win.requestAnimationFrame; ++i) {
            win.requestAnimationFrame = win[vendors[i]+'RequestAnimationFrame'];
            win.cancelAnimationFrame  = win[vendors[i]+'CancelAnimationFrame'] ||
                                        win[vendors[i]+'CancelRequestAnimationFrame'];
        }
        if (win.requestAnimationFrame && win.cancelAnimationFrame) {
            draw = function(previousRequestID, callback) {
                win.cancelAnimationFrame(previousRequestID);
                return win.requestAnimationFrame(callback);
            };
        }


        //// HOT SWAPPING ////

        // Returns boolean indicating if the swap was successful.
        // Requires that the two signal graphs have exactly the same
        // structure.
        function hotSwap(from, to) {
            function similar(nodeOld,nodeNew) {
                var idOkay = nodeOld.id === nodeNew.id;
                var lengthOkay = nodeOld.kids.length === nodeNew.kids.length;
                return idOkay && lengthOkay;
            }
            function swap(nodeOld,nodeNew) {
                nodeNew.value = nodeOld.value;
                return true;
            }
            var canSwap = depthFirstTraversals(similar, from.inputs, to.inputs);
            if (canSwap) {
                depthFirstTraversals(swap, from.inputs, to.inputs);
            }
            from.node.parentNode.replaceChild(to.node, from.node);

            return canSwap;
        }

        // Returns false if the node operation f ever fails.
        function depthFirstTraversals(f, queueOld, queueNew) {
            if (queueOld.length !== queueNew.length) return false;
            queueOld = queueOld.slice(0);
            queueNew = queueNew.slice(0);

            var seen = [];
            while (queueOld.length > 0 && queueNew.length > 0) {
                var nodeOld = queueOld.pop();
                var nodeNew = queueNew.pop();
                if (seen.indexOf(nodeOld.id) < 0) {
                    if (!f(nodeOld, nodeNew)) return false;
                    queueOld = queueOld.concat(nodeOld.kids);
                    queueNew = queueNew.concat(nodeNew.kids);
                    seen.push(nodeOld.id);
                }
            }
            return true;
        }
    }());

    function F2(fun) {
      function wrapper(a) { return function(b) { return fun(a,b) } }
      wrapper.arity = 2;
      wrapper.func = fun;
      return wrapper;
    }

    function F3(fun) {
      function wrapper(a) {
        return function(b) { return function(c) { return fun(a,b,c) }}
      }
      wrapper.arity = 3;
      wrapper.func = fun;
      return wrapper;
    }

    function F4(fun) {
      function wrapper(a) { return function(b) { return function(c) {
        return function(d) { return fun(a,b,c,d) }}}
      }
      wrapper.arity = 4;
      wrapper.func = fun;
      return wrapper;
    }

    function F5(fun) {
      function wrapper(a) { return function(b) { return function(c) {
        return function(d) { return function(e) { return fun(a,b,c,d,e) }}}}
      }
      wrapper.arity = 5;
      wrapper.func = fun;
      return wrapper;
    }

    function F6(fun) {
      function wrapper(a) { return function(b) { return function(c) {
        return function(d) { return function(e) { return function(f) {
          return fun(a,b,c,d,e,f) }}}}}
      }
      wrapper.arity = 6;
      wrapper.func = fun;
      return wrapper;
    }

    function F7(fun) {
      function wrapper(a) { return function(b) { return function(c) {
        return function(d) { return function(e) { return function(f) {
          return function(g) { return fun(a,b,c,d,e,f,g) }}}}}}
      }
      wrapper.arity = 7;
      wrapper.func = fun;
      return wrapper;
    }

    function F8(fun) {
      function wrapper(a) { return function(b) { return function(c) {
        return function(d) { return function(e) { return function(f) {
      return function(g) { return function(h) {return fun(a,b,c,d,e,f,g,h)}}}}}}}
      }
      wrapper.arity = 8;
      wrapper.func = fun;
      return wrapper;
    }

    function F9(fun) {
      function wrapper(a) { return function(b) { return function(c) {
        return function(d) { return function(e) { return function(f) {
      return function(g) { return function(h) { return function(i) {
            return fun(a,b,c,d,e,f,g,h,i) }}}}}}}}
      }
      wrapper.arity = 9;
      wrapper.func = fun;
      return wrapper;
    }

    function A2(fun,a,b) {
        return fun.arity === 2
            ? fun.func(a,b)
            : fun(a)(b);
    }
    function A3(fun,a,b,c) {
        return fun.arity === 3
            ? fun.func(a,b,c)
            : fun(a)(b)(c);
    }
    function A4(fun,a,b,c,d) {
        return fun.arity === 4
            ? fun.func(a,b,c,d)
            : fun(a)(b)(c)(d);
    }
    function A5(fun,a,b,c,d,e) {
        return fun.arity === 5
            ? fun.func(a,b,c,d,e)
            : fun(a)(b)(c)(d)(e);
    }
    function A6(fun,a,b,c,d,e,f) {
        return fun.arity === 6
            ? fun.func(a,b,c,d,e,f)
            : fun(a)(b)(c)(d)(e)(f);
    }
    function A7(fun,a,b,c,d,e,f,g) {
        return fun.arity === 7
            ? fun.func(a,b,c,d,e,f,g)
            : fun(a)(b)(c)(d)(e)(f)(g);
    }
    function A8(fun,a,b,c,d,e,f,g,h) {
        return fun.arity === 8
            ? fun.func(a,b,c,d,e,f,g,h)
            : fun(a)(b)(c)(d)(e)(f)(g)(h);
    }
    function A9(fun,a,b,c,d,e,f,g,h,i) {
        return fun.arity === 9
            ? fun.func(a,b,c,d,e,f,g,h,i)
            : fun(a)(b)(c)(d)(e)(f)(g)(h)(i);
    }
}