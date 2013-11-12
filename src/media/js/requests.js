define('requests',
    ['cache', 'defer', 'log', 'utils'],
    function(cache, defer, log, utils) {

    var console = log('req');

    /*
    Methods:

    - get(url)
      Makes a GET request to the specified URL.

      Returns a promise object similar to the one returned by jQuery AJAX
      methods. If the response to the request is cached, the returned
      promise will have a property `__cached` set to `true`.

      If you do not want your request intentionally cached, use `_get`
      (which has an identical prototype) instead.

    - post|put|patch(url, body)
      Makes a POST/PUT/PATCH request to the specified URL with the given body.

      Returns a promise object similar to the one returned by jQuery AJAX
      methods. These requests are never intentionally cached.

    - del(url)
      Makes a DELETE request to the specified URL.

      Returns a promise object similar to the one returned by jQuery AJAX
      methods. These requests are never intentionally cached.

    - pool()
      Creates a new request pool and returns the request pool.

      Returns a request pool object. All request pool objects are promises
      which complete when all requests in the pool have completed.


    Request Pool Methods:

    - get(url)
      Functionally similar to the root `get()` method.

      If a GET request to that URL has already been made, that request's
      promise is returned instead.

      The initiated request is added to the pool. The request will block the
      pool's promise from resolving or rejecting.

    - post|put|patch(url, body)
      Functionally similar to the root counterparts with pool support.

    - del(url)
      Functionally similar to the root `del()` method with pool support.

    - finish()
      Closes the pool. If no requests have been made
      at this point, the pool's promise will resolve.

    - abort()
      Aborts all requests in the pool. Rejects the pool's promise.

    Hooks:

    Define hooks like this:

      requests.on('hookname', function(xhr) {})

    Available hooks:
    - success: Fired when a request is successful. Same arguments that would
      be sent to the deferred of the request.
    - failure: Fired when a request is unsuccessful. Same arguments that would
      be sent to the deferred of the request.
    - deprecated: Fired when a request is returned with an API-Status header of
      "Deprecated".

    */

    var hooks = {};
    function callHooks(event, data) {
        if (!(event in hooks)) {
            return;
        }
        for (var i = 0, e; e = hooks[event][i++];) {
            e.apply(e, data);
        }
    }

    function _is_obj(obj) {
        return obj && obj.constructor === Object;
    }

    function _has_object_props(obj) {
        for (var i in obj) {
            if (obj.hasOwnProperty(i) && _is_obj(obj[i])) {
                return true;
            }
        }
    }

    function _ajax(type, url, data) {
        var xhr = new XMLHttpRequest();
        var def = defer.Deferred();

        function response(xhr) {
            var data = xhr.responseText;
            if ((xhr.getResponseHeader('Content-Type') || '').split(';', 1)[0] === 'application/json') {
                try {
                    return JSON.parse(data);
                } catch(e) {
                    // Oh well.
                    return {};
                }
            }
            return null;
        }

        function error() {
            def.reject(xhr, xhr.statusText, xhr.status, response(xhr));
        }

        xhr.addEventListener('load', function() {
            try {
                if (xhr.getResponseHeader('API-Status') === 'Deprecated') {
                    callHooks('deprecated', [xhr]);
                }
            } catch(e) {}

            var statusCode = xhr.status / 100 | 0;
            if (statusCode < 2 || statusCode > 3) {
                return error();
            }

            def.resolve(response(xhr), xhr);
        }, false);

        xhr.addEventListener('error', error, false);

        xhr.open(type, url, true);

        var content_type = 'application/x-www-form-urlencoded';
        if (data) {
            if (_is_obj(data) && !_has_object_props(data)) {
                data = utils.urlencode(data);
            } else if (!(data instanceof RawData)) {
                data = JSON.stringify(data);
                content_type = 'application/json';
            } else {
                data = data.toString();
                content_type = 'text/plain';
            }
            xhr.setRequestHeader('Content-Type', content_type);
        }
        xhr.send(data || undefined);

        return def.promise(xhr);
    }

    function ajax() {
        var def = _ajax.apply(this, arguments);
        var type = arguments[0];
        // then() returns a new promise, so don't return that.
        def.then(function() {
            callHooks('success', arguments);
        }, function(xhr, error, status) {
            callHooks('failure', arguments);
            handle_errors(xhr, type, status);
        });
        return def;
    }

    function get(url, nocache, persistent) {
        if (cache.has(url) && !nocache) {
            console.log('GETing from cache', url);
            return defer.Deferred()
                        .resolve(cache.get(url))
                        .promise({__cached: true});
        }
        return _get.apply(this, arguments, persistent);
    }

    function _get(url, nocache, persistent) {
        console.log('GETing', url);
        return ajax('GET', url).done(function(data, xhr) {
            console.log('GOT', url);
            if (!nocache) {
                cache.set(url, data);
                if (persistent) cache.persist.set(url, data);
            }
        });
    }

    function handle_errors(xhr, type, status) {
        console.log('Request failed:', type, status);
        if (xhr.responseText) {
            try {
                var data = JSON.parse(xhr.responseText);
                if ('error_message' in data) {
                    console.log('Error message: ', data.error_message);
                } else {
                    console.log('Response data: ', xhr.responseText);
                }
            } catch(e) {}
        }
    }

    function del(url) {
        console.log('DELETing', url);
        return ajax('DELETE', url).done(function() {
            console.log('DELETEd', url);
        });
    }

    function patch(url, data) {
        console.log('PATCHing', url);
        return ajax('PATCH', url, data).done(function() {
            console.log('PATCHed', url);
        });
    }

    function post(url, data) {
        console.log('POSTing', url);
        return ajax('POST', url, data).done(function() {
            console.log('POSTed', url);
        });
    }

    function put(url, data) {
        console.log('PUTing', url);
        return ajax('PUT', url, data).done(function() {
            console.log('PUT', url);
        });
    }

    function Pool() {
        console.log('Opening pool');
        var requests = [];
        var req_map = {};

        var def = defer.Deferred();
        var initiated = 0;
        var marked_to_finish = false;
        var closed = false;

        function finish() {
            if (closed) {
                return;
            }
            if (!initiated && marked_to_finish) {
                console.log('Closing pool');
                closed = true;

                // Resolve the deferred whenevs.
                if (window.setImmediate) {
                    setImmediate(def.resolve);
                } else {
                    setTimeout(def.resolve, 0);
                }
            }
        }

        this.finish = function() {
            marked_to_finish = true;
            finish();
        };

        function make(func, args) {
            var req = func.apply(this, args);
            initiated++;
            requests.push(req);
            req.always(function() {
                initiated--;
                finish();
            });
            return req;
        }

        this.get = function(url) {
            if (url in req_map) {
                return req_map[url];
            }
            var req = make(get, arguments);
            req_map[url] = req;
            return req;
        };
        this.del = function() {return make(del, arguments);};
        this.patch = function() {return make(patch, arguments);};
        this.post = function() {return make(post, arguments);};
        this.put = function() {return make(put, arguments);};

        this.abort = function() {
            for (var i = 0, request; request = requests[i++];) {
                if (request.abort === undefined || request.readyState === 4) {
                    continue;
                }
                request.abort();
            }
            def.reject();
        };

        def.promise(this);
    }

    function on(event, callback) {
        (hooks[event] = hooks[event] || []).push(callback);
        return {'on': on};  // For great chaining.
    }

    function RawData(data) {
        this.data = data;
        this.toString = function() {
            return this.data;
        };
    }

    return {
        get: get,
        post: post,
        del: del,
        put: put,
        patch: patch,
        pool: function() {return new Pool();},
        on: on,
        RawData: RawData,
        // This is for testing purposes.
        _set_xhr: function(func) {_ajax = func;}
    };
});
