(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({"/Users/jorge/provident/aragon/.metamask/app/scripts/inpage.js":[function(_dereq_,module,exports){
(function (global){
'use strict';

/*global Web3*/
cleanContextForImports();
_dereq_('web3/dist/web3.min.js');
var LocalMessageDuplexStream = _dereq_('post-message-stream');
// const PingStream = require('ping-pong-stream/ping')
// const endOfStream = require('end-of-stream')
var setupDappAutoReload = _dereq_('./lib/auto-reload.js');
var MetamaskInpageProvider = _dereq_('./lib/inpage-provider.js');
restoreContextAfterImports();

//
// setup plugin communication
//

// setup background connection
var metamaskStream = new LocalMessageDuplexStream({
  name: 'inpage',
  target: 'contentscript'
});

// compose the inpage provider
var inpageProvider = new MetamaskInpageProvider(metamaskStream);

//
// setup web3
//

var web3 = new Web3(inpageProvider);
web3.setProvider = function () {
  console.log('MetaMask - overrode web3.setProvider');
};
console.log('MetaMask - injected web3');
// export global web3, with usage-detection reload fn
var triggerReload = setupDappAutoReload(web3);

// listen for reset requests from metamask
var reloadStream = inpageProvider.multiStream.createStream('reload');
reloadStream.once('data', triggerReload);

// setup ping timeout autoreload
// LocalMessageDuplexStream does not self-close, so reload if pingStream fails
// var pingChannel = inpageProvider.multiStream.createStream('pingpong')
// var pingStream = new PingStream({ objectMode: true })
// wait for first successful reponse

// disable pingStream until https://github.com/MetaMask/metamask-plugin/issues/746 is resolved more gracefully
// metamaskStream.once('data', function(){
//   pingStream.pipe(pingChannel).pipe(pingStream)
// })
// endOfStream(pingStream, triggerReload)

// set web3 defaultAccount
inpageProvider.publicConfigStore.subscribe(function (state) {
  web3.eth.defaultAccount = state.selectedAddress;
});

//
// util
//

// need to make sure we aren't affected by overlapping namespaces
// and that we dont affect the app with our namespace
// mostly a fix for web3's BigNumber if AMD's "define" is defined...
var __define;

function cleanContextForImports() {
  __define = global.define;
  try {
    global.define = undefined;
  } catch (_) {
    console.warn('MetaMask - global.define could not be deleted.');
  }
}

function restoreContextAfterImports() {
  try {
    global.define = __define;
  } catch (_) {
    console.warn('MetaMask - global.define could not be overwritten.');
  }
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./lib/auto-reload.js":"/Users/jorge/provident/aragon/.metamask/app/scripts/lib/auto-reload.js","./lib/inpage-provider.js":"/Users/jorge/provident/aragon/.metamask/app/scripts/lib/inpage-provider.js","post-message-stream":"/Users/jorge/provident/aragon/.metamask/node_modules/post-message-stream/index.js","web3/dist/web3.min.js":"/Users/jorge/provident/aragon/.metamask/node_modules/web3/dist/web3.min.js"}],"/Users/jorge/provident/aragon/.metamask/app/scripts/lib/auto-reload.js":[function(_dereq_,module,exports){
(function (global){
'use strict';

var once = _dereq_('once');
var ensnare = _dereq_('ensnare');

module.exports = setupDappAutoReload;

function setupDappAutoReload(web3) {
  // export web3 as a global, checking for usage
  var pageIsUsingWeb3 = false;
  var resetWasRequested = false;
  global.web3 = ensnare(web3, once(function () {
    // if web3 usage happened after a reset request, trigger reset late
    if (resetWasRequested) return triggerReset();
    // mark web3 as used
    pageIsUsingWeb3 = true;
    // reset web3 reference
    global.web3 = web3;
  }));

  return handleResetRequest;

  function handleResetRequest() {
    resetWasRequested = true;
    // ignore if web3 was not used
    if (!pageIsUsingWeb3) return;
    // reload after short timeout
    setTimeout(triggerReset, 500);
  }
}

// reload the page
function triggerReset() {
  global.location.reload();
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"ensnare":"/Users/jorge/provident/aragon/.metamask/node_modules/ensnare/index.js","once":"/Users/jorge/provident/aragon/.metamask/node_modules/once/once.js"}],"/Users/jorge/provident/aragon/.metamask/app/scripts/lib/inpage-provider.js":[function(_dereq_,module,exports){
'use strict';

var pipe = _dereq_('pump');
var StreamProvider = _dereq_('web3-stream-provider');
var LocalStorageStore = _dereq_('obs-store');
var ObjectMultiplex = _dereq_('./obj-multiplex');
var createRandomId = _dereq_('./random-id');

module.exports = MetamaskInpageProvider;

function MetamaskInpageProvider(connectionStream) {
  var self = this;

  // setup connectionStream multiplexing
  var multiStream = self.multiStream = ObjectMultiplex();
  pipe(connectionStream, multiStream, connectionStream, function (err) {
    return logStreamDisconnectWarning('MetaMask', err);
  });

  // subscribe to metamask public config (one-way)
  self.publicConfigStore = new LocalStorageStore({ storageKey: 'MetaMask-Config' });
  pipe(multiStream.createStream('publicConfig'), self.publicConfigStore, function (err) {
    return logStreamDisconnectWarning('MetaMask PublicConfigStore', err);
  });

  // connect to async provider
  var asyncProvider = self.asyncProvider = new StreamProvider();
  pipe(asyncProvider, multiStream.createStream('provider'), asyncProvider, function (err) {
    return logStreamDisconnectWarning('MetaMask RpcProvider', err);
  });

  self.idMap = {};
  // handle sendAsync requests via asyncProvider
  self.sendAsync = function (payload, cb) {
    // rewrite request ids
    var request = eachJsonMessage(payload, function (message) {
      var newId = createRandomId();
      self.idMap[newId] = message.id;
      message.id = newId;
      return message;
    });
    // forward to asyncProvider
    asyncProvider.sendAsync(request, function (err, res) {
      if (err) return cb(err);
      // transform messages to original ids
      eachJsonMessage(res, function (message) {
        var oldId = self.idMap[message.id];
        delete self.idMap[message.id];
        message.id = oldId;
        return message;
      });
      cb(null, res);
    });
  };
}

MetamaskInpageProvider.prototype.send = function (payload) {
  var self = this;

  var selectedAddress = void 0;
  var result = null;
  switch (payload.method) {

    case 'eth_accounts':
      // read from localStorage
      selectedAddress = self.publicConfigStore.getState().selectedAddress;
      result = selectedAddress ? [selectedAddress] : [];
      break;

    case 'eth_coinbase':
      // read from localStorage
      selectedAddress = self.publicConfigStore.getState().selectedAddress;
      result = selectedAddress;
      break;

    case 'eth_uninstallFilter':
      self.sendAsync(payload, noop);
      result = true;
      break;

    case 'net_version':
      var networkVersion = self.publicConfigStore.getState().networkVersion;
      result = networkVersion;
      break;

    // throw not-supported Error
    default:
      var link = 'https://github.com/MetaMask/faq/blob/master/DEVELOPERS.md#dizzy-all-async---think-of-metamask-as-a-light-client';
      var message = 'The MetaMask Web3 object does not support synchronous methods like ' + payload.method + ' without a callback parameter. See ' + link + ' for details.';
      throw new Error(message);

  }

  // return the result
  return {
    id: payload.id,
    jsonrpc: payload.jsonrpc,
    result: result
  };
};

MetamaskInpageProvider.prototype.sendAsync = function () {
  throw new Error('MetamaskInpageProvider - sendAsync not overwritten');
};

MetamaskInpageProvider.prototype.isConnected = function () {
  return true;
};

MetamaskInpageProvider.prototype.isMetaMask = true;

// util

function eachJsonMessage(payload, transformFn) {
  if (Array.isArray(payload)) {
    return payload.map(transformFn);
  } else {
    return transformFn(payload);
  }
}

function logStreamDisconnectWarning(remoteLabel, err) {
  var warningMsg = 'MetamaskInpageProvider - lost connection to ' + remoteLabel;
  if (err) warningMsg += '\n' + err.stack;
  console.warn(warningMsg);
}

function noop() {}

},{"./obj-multiplex":"/Users/jorge/provident/aragon/.metamask/app/scripts/lib/obj-multiplex.js","./random-id":"/Users/jorge/provident/aragon/.metamask/app/scripts/lib/random-id.js","obs-store":"/Users/jorge/provident/aragon/.metamask/node_modules/obs-store/index.js","pump":"/Users/jorge/provident/aragon/.metamask/node_modules/pump/index.js","web3-stream-provider":"/Users/jorge/provident/aragon/.metamask/node_modules/web3-stream-provider/index.js"}],"/Users/jorge/provident/aragon/.metamask/app/scripts/lib/obj-multiplex.js":[function(_dereq_,module,exports){
'use strict';

var through = _dereq_('through2');

module.exports = ObjectMultiplex;

function ObjectMultiplex(opts) {
  opts = opts || {};
  // create multiplexer
  var mx = through.obj(function (chunk, enc, cb) {
    var name = chunk.name;
    var data = chunk.data;
    var substream = mx.streams[name];
    if (!substream) {
      console.warn('orphaned data for stream "' + name + '"');
    } else {
      if (substream.push) substream.push(data);
    }
    return cb();
  });
  mx.streams = {};
  // create substreams
  mx.createStream = function (name) {
    var substream = mx.streams[name] = through.obj(function (chunk, enc, cb) {
      mx.push({
        name: name,
        data: chunk
      });
      return cb();
    });
    mx.on('end', function () {
      return substream.emit('end');
    });
    if (opts.error) {
      mx.on('error', function () {
        return substream.emit('error');
      });
    }
    return substream;
  };
  // ignore streams (dont display orphaned data warning)
  mx.ignoreStream = function (name) {
    mx.streams[name] = true;
  };
  return mx;
}

},{"through2":"/Users/jorge/provident/aragon/.metamask/node_modules/through2/through2.js"}],"/Users/jorge/provident/aragon/.metamask/app/scripts/lib/random-id.js":[function(_dereq_,module,exports){
"use strict";

var MAX = Number.MAX_SAFE_INTEGER;

var idCounter = Math.round(Math.random() * MAX);
function createRandomId() {
  idCounter = idCounter % MAX;
  return idCounter++;
}

module.exports = createRandomId;

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/browser-resolve/empty.js":[function(_dereq_,module,exports){

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/browserify/node_modules/process/browser.js":[function(_dereq_,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/buffer-shims/index.js":[function(_dereq_,module,exports){
(function (global){
'use strict';

var buffer = _dereq_('buffer');
var Buffer = buffer.Buffer;
var SlowBuffer = buffer.SlowBuffer;
var MAX_LEN = buffer.kMaxLength || 2147483647;
exports.alloc = function alloc(size, fill, encoding) {
  if (typeof Buffer.alloc === 'function') {
    return Buffer.alloc(size, fill, encoding);
  }
  if (typeof encoding === 'number') {
    throw new TypeError('encoding must not be number');
  }
  if (typeof size !== 'number') {
    throw new TypeError('size must be a number');
  }
  if (size > MAX_LEN) {
    throw new RangeError('size is too large');
  }
  var enc = encoding;
  var _fill = fill;
  if (_fill === undefined) {
    enc = undefined;
    _fill = 0;
  }
  var buf = new Buffer(size);
  if (typeof _fill === 'string') {
    var fillBuf = new Buffer(_fill, enc);
    var flen = fillBuf.length;
    var i = -1;
    while (++i < size) {
      buf[i] = fillBuf[i % flen];
    }
  } else {
    buf.fill(_fill);
  }
  return buf;
}
exports.allocUnsafe = function allocUnsafe(size) {
  if (typeof Buffer.allocUnsafe === 'function') {
    return Buffer.allocUnsafe(size);
  }
  if (typeof size !== 'number') {
    throw new TypeError('size must be a number');
  }
  if (size > MAX_LEN) {
    throw new RangeError('size is too large');
  }
  return new Buffer(size);
}
exports.from = function from(value, encodingOrOffset, length) {
  if (typeof Buffer.from === 'function' && (!global.Uint8Array || Uint8Array.from !== Buffer.from)) {
    return Buffer.from(value, encodingOrOffset, length);
  }
  if (typeof value === 'number') {
    throw new TypeError('"value" argument must not be a number');
  }
  if (typeof value === 'string') {
    return new Buffer(value, encodingOrOffset);
  }
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    var offset = encodingOrOffset;
    if (arguments.length === 1) {
      return new Buffer(value);
    }
    if (typeof offset === 'undefined') {
      offset = 0;
    }
    var len = length;
    if (typeof len === 'undefined') {
      len = value.byteLength - offset;
    }
    if (offset >= value.byteLength) {
      throw new RangeError('\'offset\' is out of bounds');
    }
    if (len > value.byteLength - offset) {
      throw new RangeError('\'length\' is out of bounds');
    }
    return new Buffer(value.slice(offset, offset + len));
  }
  if (Buffer.isBuffer(value)) {
    var out = new Buffer(value.length);
    value.copy(out, 0, 0, value.length);
    return out;
  }
  if (value) {
    if (Array.isArray(value) || (typeof ArrayBuffer !== 'undefined' && value.buffer instanceof ArrayBuffer) || 'length' in value) {
      return new Buffer(value);
    }
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
      return new Buffer(value.data);
    }
  }

  throw new TypeError('First argument must be a string, Buffer, ' + 'ArrayBuffer, Array, or array-like object.');
}
exports.allocUnsafeSlow = function allocUnsafeSlow(size) {
  if (typeof Buffer.allocUnsafeSlow === 'function') {
    return Buffer.allocUnsafeSlow(size);
  }
  if (typeof size !== 'number') {
    throw new TypeError('size must be a number');
  }
  if (size >= MAX_LEN) {
    throw new RangeError('size is too large');
  }
  return new SlowBuffer(size);
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"buffer":"/Users/jorge/provident/aragon/.metamask/node_modules/buffer/index.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/buffer/index.js":[function(_dereq_,module,exports){
(function (global){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = _dereq_('base64-js')
var ieee754 = _dereq_('ieee754')
var isArray = _dereq_('isarray')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Due to various browser bugs, sometimes the Object implementation will be used even
 * when the browser supports typed arrays.
 *
 * Note:
 *
 *   - Firefox 4-29 lacks support for adding new properties to `Uint8Array` instances,
 *     See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *   - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *   - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *     incorrect length in some situations.

 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they
 * get the Object implementation, which is slower but behaves correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = global.TYPED_ARRAY_SUPPORT !== undefined
  ? global.TYPED_ARRAY_SUPPORT
  : typedArraySupport()

/*
 * Export kMaxLength after typed array support is determined.
 */
exports.kMaxLength = kMaxLength()

function typedArraySupport () {
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = {__proto__: Uint8Array.prototype, foo: function () { return 42 }}
    return arr.foo() === 42 && // typed array instances can be augmented
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        arr.subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
}

function kMaxLength () {
  return Buffer.TYPED_ARRAY_SUPPORT
    ? 0x7fffffff
    : 0x3fffffff
}

function createBuffer (that, length) {
  if (kMaxLength() < length) {
    throw new RangeError('Invalid typed array length')
  }
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    that = new Uint8Array(length)
    that.__proto__ = Buffer.prototype
  } else {
    // Fallback: Return an object instance of the Buffer class
    if (that === null) {
      that = new Buffer(length)
    }
    that.length = length
  }

  return that
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  if (!Buffer.TYPED_ARRAY_SUPPORT && !(this instanceof Buffer)) {
    return new Buffer(arg, encodingOrOffset, length)
  }

  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new Error(
        'If encoding is specified then the first argument must be a string'
      )
    }
    return allocUnsafe(this, arg)
  }
  return from(this, arg, encodingOrOffset, length)
}

Buffer.poolSize = 8192 // not used by this implementation

// TODO: Legacy, not needed anymore. Remove in next major version.
Buffer._augment = function (arr) {
  arr.__proto__ = Buffer.prototype
  return arr
}

function from (that, value, encodingOrOffset, length) {
  if (typeof value === 'number') {
    throw new TypeError('"value" argument must not be a number')
  }

  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    return fromArrayBuffer(that, value, encodingOrOffset, length)
  }

  if (typeof value === 'string') {
    return fromString(that, value, encodingOrOffset)
  }

  return fromObject(that, value)
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(null, value, encodingOrOffset, length)
}

if (Buffer.TYPED_ARRAY_SUPPORT) {
  Buffer.prototype.__proto__ = Uint8Array.prototype
  Buffer.__proto__ = Uint8Array
  if (typeof Symbol !== 'undefined' && Symbol.species &&
      Buffer[Symbol.species] === Buffer) {
    // Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
    Object.defineProperty(Buffer, Symbol.species, {
      value: null,
      configurable: true
    })
  }
}

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be a number')
  } else if (size < 0) {
    throw new RangeError('"size" argument must not be negative')
  }
}

function alloc (that, size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(that, size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(that, size).fill(fill, encoding)
      : createBuffer(that, size).fill(fill)
  }
  return createBuffer(that, size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(null, size, fill, encoding)
}

function allocUnsafe (that, size) {
  assertSize(size)
  that = createBuffer(that, size < 0 ? 0 : checked(size) | 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < size; ++i) {
      that[i] = 0
    }
  }
  return that
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(null, size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(null, size)
}

function fromString (that, string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('"encoding" must be a valid string encoding')
  }

  var length = byteLength(string, encoding) | 0
  that = createBuffer(that, length)

  var actual = that.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    that = that.slice(0, actual)
  }

  return that
}

function fromArrayLike (that, array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  that = createBuffer(that, length)
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

function fromArrayBuffer (that, array, byteOffset, length) {
  array.byteLength // this throws if `array` is not a valid ArrayBuffer

  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('\'offset\' is out of bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('\'length\' is out of bounds')
  }

  if (byteOffset === undefined && length === undefined) {
    array = new Uint8Array(array)
  } else if (length === undefined) {
    array = new Uint8Array(array, byteOffset)
  } else {
    array = new Uint8Array(array, byteOffset, length)
  }

  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    that = array
    that.__proto__ = Buffer.prototype
  } else {
    // Fallback: Return an object instance of the Buffer class
    that = fromArrayLike(that, array)
  }
  return that
}

function fromObject (that, obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    that = createBuffer(that, len)

    if (that.length === 0) {
      return that
    }

    obj.copy(that, 0, 0, len)
    return that
  }

  if (obj) {
    if ((typeof ArrayBuffer !== 'undefined' &&
        obj.buffer instanceof ArrayBuffer) || 'length' in obj) {
      if (typeof obj.length !== 'number' || isnan(obj.length)) {
        return createBuffer(that, 0)
      }
      return fromArrayLike(that, obj)
    }

    if (obj.type === 'Buffer' && isArray(obj.data)) {
      return fromArrayLike(that, obj.data)
    }
  }

  throw new TypeError('First argument must be a string, Buffer, ArrayBuffer, Array, or array-like object.')
}

function checked (length) {
  // Note: cannot use `length < kMaxLength()` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= kMaxLength()) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + kMaxLength().toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' &&
      (ArrayBuffer.isView(string) || string instanceof ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    string = '' + string
  }

  var len = string.length
  if (len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
      case undefined:
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) return utf8ToBytes(string).length // assume utf8
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// The property is used by `Buffer.isBuffer` and `is-buffer` (in Safari 5-7) to detect
// Buffer instances.
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length | 0
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (!Buffer.isBuffer(target)) {
    throw new TypeError('Argument must be a Buffer')
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset  // Coerce to Number.
  if (isNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (Buffer.TYPED_ARRAY_SUPPORT &&
        typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new TypeError('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset | 0
    if (isFinite(length)) {
      length = length | 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  // legacy write(string, encoding, offset, length) - remove in v0.13
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
      : (firstByte > 0xBF) ? 2
      : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    newBuf = this.subarray(start, end)
    newBuf.__proto__ = Buffer.prototype
  } else {
    var sliceLen = end - start
    newBuf = new Buffer(sliceLen, undefined)
    for (var i = 0; i < sliceLen; ++i) {
      newBuf[i] = this[i + start]
    }
  }

  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = (value & 0xff)
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; ++i) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; ++i) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start
  var i

  if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
    // ascending copy from start
    for (i = 0; i < len; ++i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, start + len),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if (code < 256) {
        val = code
      }
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : utf8ToBytes(new Buffer(val, encoding).toString())
    var len = bytes.length
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+\/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

function isnan (val) {
  return val !== val // eslint-disable-line no-self-compare
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"base64-js":"/Users/jorge/provident/aragon/.metamask/node_modules/buffer/node_modules/base64-js/index.js","ieee754":"/Users/jorge/provident/aragon/.metamask/node_modules/ieee754/index.js","isarray":"/Users/jorge/provident/aragon/.metamask/node_modules/isarray/index.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/buffer/node_modules/base64-js/index.js":[function(_dereq_,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function placeHoldersCount (b64) {
  var len = b64.length
  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // the number of equal signs (place holders)
  // if there are two placeholders, than the two characters before it
  // represent one byte
  // if there is only one, then the three characters before it represent 2 bytes
  // this is just a cheap hack to not do indexOf twice
  return b64[len - 2] === '=' ? 2 : b64[len - 1] === '=' ? 1 : 0
}

function byteLength (b64) {
  // base64 is 4/3 + up to two characters of the original data
  return b64.length * 3 / 4 - placeHoldersCount(b64)
}

function toByteArray (b64) {
  var i, j, l, tmp, placeHolders, arr
  var len = b64.length
  placeHolders = placeHoldersCount(b64)

  arr = new Arr(len * 3 / 4 - placeHolders)

  // if there are placeholders, only get up to the last complete 4 chars
  l = placeHolders > 0 ? len - 4 : len

  var L = 0

  for (i = 0, j = 0; i < l; i += 4, j += 3) {
    tmp = (revLookup[b64.charCodeAt(i)] << 18) | (revLookup[b64.charCodeAt(i + 1)] << 12) | (revLookup[b64.charCodeAt(i + 2)] << 6) | revLookup[b64.charCodeAt(i + 3)]
    arr[L++] = (tmp >> 16) & 0xFF
    arr[L++] = (tmp >> 8) & 0xFF
    arr[L++] = tmp & 0xFF
  }

  if (placeHolders === 2) {
    tmp = (revLookup[b64.charCodeAt(i)] << 2) | (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[L++] = tmp & 0xFF
  } else if (placeHolders === 1) {
    tmp = (revLookup[b64.charCodeAt(i)] << 10) | (revLookup[b64.charCodeAt(i + 1)] << 4) | (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[L++] = (tmp >> 8) & 0xFF
    arr[L++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] + lookup[num >> 12 & 0x3F] + lookup[num >> 6 & 0x3F] + lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var output = ''
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    output += lookup[tmp >> 2]
    output += lookup[(tmp << 4) & 0x3F]
    output += '=='
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + (uint8[len - 1])
    output += lookup[tmp >> 10]
    output += lookup[(tmp >> 4) & 0x3F]
    output += lookup[(tmp << 2) & 0x3F]
    output += '='
  }

  parts.push(output)

  return parts.join('')
}

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/core-util-is/lib/util.js":[function(_dereq_,module,exports){
(function (Buffer){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.

function isArray(arg) {
  if (Array.isArray) {
    return Array.isArray(arg);
  }
  return objectToString(arg) === '[object Array]';
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = Buffer.isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}

}).call(this,{"isBuffer":_dereq_("../../is-buffer/index.js")})

},{"../../is-buffer/index.js":"/Users/jorge/provident/aragon/.metamask/node_modules/is-buffer/index.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/end-of-stream/index.js":[function(_dereq_,module,exports){
var once = _dereq_('once');

var noop = function() {};

var isRequest = function(stream) {
	return stream.setHeader && typeof stream.abort === 'function';
};

var isChildProcess = function(stream) {
	return stream.stdio && Array.isArray(stream.stdio) && stream.stdio.length === 3
};

var eos = function(stream, opts, callback) {
	if (typeof opts === 'function') return eos(stream, null, opts);
	if (!opts) opts = {};

	callback = once(callback || noop);

	var ws = stream._writableState;
	var rs = stream._readableState;
	var readable = opts.readable || (opts.readable !== false && stream.readable);
	var writable = opts.writable || (opts.writable !== false && stream.writable);

	var onlegacyfinish = function() {
		if (!stream.writable) onfinish();
	};

	var onfinish = function() {
		writable = false;
		if (!readable) callback();
	};

	var onend = function() {
		readable = false;
		if (!writable) callback();
	};

	var onexit = function(exitCode) {
		callback(exitCode ? new Error('exited with error code: ' + exitCode) : null);
	};

	var onclose = function() {
		if (readable && !(rs && rs.ended)) return callback(new Error('premature close'));
		if (writable && !(ws && ws.ended)) return callback(new Error('premature close'));
	};

	var onrequest = function() {
		stream.req.on('finish', onfinish);
	};

	if (isRequest(stream)) {
		stream.on('complete', onfinish);
		stream.on('abort', onclose);
		if (stream.req) onrequest();
		else stream.on('request', onrequest);
	} else if (writable && !ws) { // legacy streams
		stream.on('end', onlegacyfinish);
		stream.on('close', onlegacyfinish);
	}

	if (isChildProcess(stream)) stream.on('exit', onexit);

	stream.on('end', onend);
	stream.on('finish', onfinish);
	if (opts.error !== false) stream.on('error', callback);
	stream.on('close', onclose);

	return function() {
		stream.removeListener('complete', onfinish);
		stream.removeListener('abort', onclose);
		stream.removeListener('request', onrequest);
		if (stream.req) stream.req.removeListener('finish', onfinish);
		stream.removeListener('end', onlegacyfinish);
		stream.removeListener('close', onlegacyfinish);
		stream.removeListener('finish', onfinish);
		stream.removeListener('exit', onexit);
		stream.removeListener('end', onend);
		stream.removeListener('error', callback);
		stream.removeListener('close', onclose);
	};
};

module.exports = eos;
},{"once":"/Users/jorge/provident/aragon/.metamask/node_modules/end-of-stream/node_modules/once/once.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/end-of-stream/node_modules/once/once.js":[function(_dereq_,module,exports){
var wrappy = _dereq_('wrappy')
module.exports = wrappy(once)

once.proto = once(function () {
  Object.defineProperty(Function.prototype, 'once', {
    value: function () {
      return once(this)
    },
    configurable: true
  })
})

function once (fn) {
  var f = function () {
    if (f.called) return f.value
    f.called = true
    return f.value = fn.apply(this, arguments)
  }
  f.called = false
  return f
}

},{"wrappy":"/Users/jorge/provident/aragon/.metamask/node_modules/wrappy/wrappy.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/ensnare/index.js":[function(_dereq_,module,exports){
module.exports = ensnare

// creates a proxy object that calls cb everytime the obj's properties/fns are accessed
function ensnare (obj, cb) {
  var proxy = {}
  getAllPropertyNames(obj).forEach(function (key) {
    var val = obj[key]
    switch (typeof val) {
      
      // bind function to original obj
      case 'function':
        proxy[key] = function () {
          cb()
          return val.apply(obj, arguments)
        }
        return

      // pass through to setter getter
      default:
        Object.defineProperty(proxy, key, {
          get: function () {
            cb()
            return obj[key]
          },
          set: function (val) {
            cb()
            obj[key] = val
            return val
          },
        })
        return
    }
  })
  return proxy
}

function getAllPropertyNames(obj) {
  var props = []
  walkPrototypeChain(obj, function(target){
    for (key in target) {

      // only add props if unique
      if ( props.indexOf( key ) === -1 ) {
        props.push( key )
      }

    }
  })
  return props
}

function walkPrototypeChain(obj, fn) {
  var target = obj
  do {
    fn(target)
  } while ( target = Object.getPrototypeOf( target ) )
}
},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/events/events.js":[function(_dereq_,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      } else {
        // At least give some kind of context to the user
        var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
        err.context = er;
        throw err;
      }
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/ieee754/index.js":[function(_dereq_,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/inherits/inherits_browser.js":[function(_dereq_,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/is-buffer/index.js":[function(_dereq_,module,exports){
/*!
 * Determine if an object is a Buffer
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */

// The _isBuffer check is for Safari 5-7 support, because it's missing
// Object.prototype.constructor. Remove this eventually
module.exports = function (obj) {
  return obj != null && (isBuffer(obj) || isSlowBuffer(obj) || !!obj._isBuffer)
}

function isBuffer (obj) {
  return !!obj.constructor && typeof obj.constructor.isBuffer === 'function' && obj.constructor.isBuffer(obj)
}

// For Node v0.10 support. Remove this eventually.
function isSlowBuffer (obj) {
  return typeof obj.readFloatLE === 'function' && typeof obj.slice === 'function' && isBuffer(obj.slice(0, 0))
}

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/isarray/index.js":[function(_dereq_,module,exports){
var toString = {}.toString;

module.exports = Array.isArray || function (arr) {
  return toString.call(arr) == '[object Array]';
};

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/obs-store/index.js":[function(_dereq_,module,exports){
'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var extend = _dereq_('xtend');
var DuplexStream = _dereq_('stream').Duplex;

var ObservableStore = function (_DuplexStream) {
  _inherits(ObservableStore, _DuplexStream);

  function ObservableStore() {
    var initState = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

    _classCallCheck(this, ObservableStore);

    // dont buffer outgoing updates
    var _this = _possibleConstructorReturn(this, (ObservableStore.__proto__ || Object.getPrototypeOf(ObservableStore)).call(this, {
      // pass values not serializations
      objectMode: true,
      // a writer can end and we are still readable
      allowHalfOpen: true
    }));
    // construct as duplex stream


    _this.resume();
    // set init state
    _this._state = initState;
    return _this;
  }

  // wrapper around internal getState


  _createClass(ObservableStore, [{
    key: 'getState',
    value: function getState() {
      return this._getState();
    }

    // wrapper around internal putState

  }, {
    key: 'putState',
    value: function putState(newState) {
      this._putState(newState);
      this.emit('update', newState);
      this.push(this.getState());
    }
  }, {
    key: 'updateState',
    value: function updateState(partialState) {
      var state = this.getState();
      var newState = extend({}, state, partialState);
      this.putState(newState);
    }

    // subscribe to changes

  }, {
    key: 'subscribe',
    value: function subscribe(handler) {
      this.on('update', handler);
    }

    // unsubscribe to changes

  }, {
    key: 'unsubscribe',
    value: function unsubscribe(handler) {
      this.removeListener('update', handler);
    }

    //
    // private
    //

    // read from persistence

  }, {
    key: '_getState',
    value: function _getState() {
      return this._state;
    }

    // write to persistence

  }, {
    key: '_putState',
    value: function _putState(newState) {
      this._state = newState;
    }

    //
    // stream implementation
    //

    // emit current state on new destination

  }, {
    key: 'pipe',
    value: function pipe(dest, options) {
      var result = DuplexStream.prototype.pipe.call(this, dest, options);
      dest.write(this.getState());
      return result;
    }

    // write from incomming stream to state

  }, {
    key: '_write',
    value: function _write(chunk, encoding, callback) {
      this.putState(chunk);
      callback();
    }

    // noop - outgoing stream is asking us if we have data we arent giving it

  }, {
    key: '_read',
    value: function _read(size) {}
  }]);

  return ObservableStore;
}(DuplexStream);

module.exports = ObservableStore;

},{"stream":"/Users/jorge/provident/aragon/.metamask/node_modules/stream-browserify/index.js","xtend":"/Users/jorge/provident/aragon/.metamask/node_modules/xtend/immutable.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/once/once.js":[function(_dereq_,module,exports){
var wrappy = _dereq_('wrappy')
module.exports = wrappy(once)
module.exports.strict = wrappy(onceStrict)

once.proto = once(function () {
  Object.defineProperty(Function.prototype, 'once', {
    value: function () {
      return once(this)
    },
    configurable: true
  })

  Object.defineProperty(Function.prototype, 'onceStrict', {
    value: function () {
      return onceStrict(this)
    },
    configurable: true
  })
})

function once (fn) {
  var f = function () {
    if (f.called) return f.value
    f.called = true
    return f.value = fn.apply(this, arguments)
  }
  f.called = false
  return f
}

function onceStrict (fn) {
  var f = function () {
    if (f.called)
      throw new Error(f.onceError)
    f.called = true
    return f.value = fn.apply(this, arguments)
  }
  var name = fn.name || 'Function wrapped with `once`'
  f.onceError = name + " shouldn't be called more than once"
  f.called = false
  return f
}

},{"wrappy":"/Users/jorge/provident/aragon/.metamask/node_modules/wrappy/wrappy.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/post-message-stream/index.js":[function(_dereq_,module,exports){
const DuplexStream = _dereq_('readable-stream').Duplex
const inherits = _dereq_('util').inherits

module.exports = PostMessageStream

inherits(PostMessageStream, DuplexStream)

function PostMessageStream (opts) {
  DuplexStream.call(this, {
    objectMode: true,
  })

  this._name = opts.name
  this._target = opts.target
  this._targetWindow = opts.targetWindow || window
  this._origin = (opts.targetWindow ? '*' : location.origin)

  window.addEventListener('message', this._onMessage.bind(this), false)
}

// private

PostMessageStream.prototype._onMessage = function (event) {
  var msg = event.data

  // validate message
  if (this._origin !== '*' && event.origin !== this._origin) return
  if (event.source !== this._targetWindow) return
  if (typeof msg !== 'object') return
  if (msg.target !== this._name) return
  if (!msg.data) return

  // forward message
  try {
    this.push(msg.data)
  } catch (err) {
    this.emit('error', err)
  }
}

// stream plumbing

PostMessageStream.prototype._read = noop

PostMessageStream.prototype._write = function (data, encoding, cb) {
  var message = {
    target: this._target,
    data: data,
  }
  this._targetWindow.postMessage(message, this._origin)
  cb()
}

// util

function noop () {}

},{"readable-stream":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/readable.js","util":"/Users/jorge/provident/aragon/.metamask/node_modules/util/util.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/process-nextick-args/index.js":[function(_dereq_,module,exports){
(function (process){
'use strict';

if (!process.version ||
    process.version.indexOf('v0.') === 0 ||
    process.version.indexOf('v1.') === 0 && process.version.indexOf('v1.8.') !== 0) {
  module.exports = nextTick;
} else {
  module.exports = process.nextTick;
}

function nextTick(fn, arg1, arg2, arg3) {
  if (typeof fn !== 'function') {
    throw new TypeError('"callback" argument must be a function');
  }
  var len = arguments.length;
  var args, i;
  switch (len) {
  case 0:
  case 1:
    return process.nextTick(fn);
  case 2:
    return process.nextTick(function afterTickOne() {
      fn.call(null, arg1);
    });
  case 3:
    return process.nextTick(function afterTickTwo() {
      fn.call(null, arg1, arg2);
    });
  case 4:
    return process.nextTick(function afterTickThree() {
      fn.call(null, arg1, arg2, arg3);
    });
  default:
    args = new Array(len - 1);
    i = 0;
    while (i < args.length) {
      args[i++] = arguments[i];
    }
    return process.nextTick(function afterTick() {
      fn.apply(null, args);
    });
  }
}

}).call(this,_dereq_('_process'))

},{"_process":"/Users/jorge/provident/aragon/.metamask/node_modules/browserify/node_modules/process/browser.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/pump/index.js":[function(_dereq_,module,exports){
var once = _dereq_('once')
var eos = _dereq_('end-of-stream')
var fs = _dereq_('fs') // we only need fs to get the ReadStream and WriteStream prototypes

var noop = function () {}

var isFn = function (fn) {
  return typeof fn === 'function'
}

var isFS = function (stream) {
  if (!fs) return false // browser
  return (stream instanceof (fs.ReadStream || noop) || stream instanceof (fs.WriteStream || noop)) && isFn(stream.close)
}

var isRequest = function (stream) {
  return stream.setHeader && isFn(stream.abort)
}

var destroyer = function (stream, reading, writing, callback) {
  callback = once(callback)

  var closed = false
  stream.on('close', function () {
    closed = true
  })

  eos(stream, {readable: reading, writable: writing}, function (err) {
    if (err) return callback(err)
    closed = true
    callback()
  })

  var destroyed = false
  return function (err) {
    if (closed) return
    if (destroyed) return
    destroyed = true

    if (isFS(stream)) return stream.close() // use close for fs streams to avoid fd leaks
    if (isRequest(stream)) return stream.abort() // request.destroy just do .end - .abort is what we want

    if (isFn(stream.destroy)) return stream.destroy()

    callback(err || new Error('stream was destroyed'))
  }
}

var call = function (fn) {
  fn()
}

var pipe = function (from, to) {
  return from.pipe(to)
}

var pump = function () {
  var streams = Array.prototype.slice.call(arguments)
  var callback = isFn(streams[streams.length - 1] || noop) && streams.pop() || noop

  if (Array.isArray(streams[0])) streams = streams[0]
  if (streams.length < 2) throw new Error('pump requires two streams per minimum')

  var error
  var destroys = streams.map(function (stream, i) {
    var reading = i < streams.length - 1
    var writing = i > 0
    return destroyer(stream, reading, writing, function (err) {
      if (!error) error = err
      if (err) destroys.forEach(call)
      if (reading) return
      destroys.forEach(call)
      callback(error)
    })
  })

  return streams.reduce(pipe)
}

module.exports = pump

},{"end-of-stream":"/Users/jorge/provident/aragon/.metamask/node_modules/end-of-stream/index.js","fs":"/Users/jorge/provident/aragon/.metamask/node_modules/browser-resolve/empty.js","once":"/Users/jorge/provident/aragon/.metamask/node_modules/once/once.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/duplex.js":[function(_dereq_,module,exports){
module.exports = _dereq_("./lib/_stream_duplex.js")

},{"./lib/_stream_duplex.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_duplex.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_duplex.js":[function(_dereq_,module,exports){
// a duplex stream is just a stream that is both readable and writable.
// Since JS doesn't have multiple prototypal inheritance, this class
// prototypally inherits from Readable, and then parasitically from
// Writable.

'use strict';

/*<replacement>*/

var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) {
    keys.push(key);
  }return keys;
};
/*</replacement>*/

module.exports = Duplex;

/*<replacement>*/
var processNextTick = _dereq_('process-nextick-args');
/*</replacement>*/

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

var Readable = _dereq_('./_stream_readable');
var Writable = _dereq_('./_stream_writable');

util.inherits(Duplex, Readable);

var keys = objectKeys(Writable.prototype);
for (var v = 0; v < keys.length; v++) {
  var method = keys[v];
  if (!Duplex.prototype[method]) Duplex.prototype[method] = Writable.prototype[method];
}

function Duplex(options) {
  if (!(this instanceof Duplex)) return new Duplex(options);

  Readable.call(this, options);
  Writable.call(this, options);

  if (options && options.readable === false) this.readable = false;

  if (options && options.writable === false) this.writable = false;

  this.allowHalfOpen = true;
  if (options && options.allowHalfOpen === false) this.allowHalfOpen = false;

  this.once('end', onend);
}

// the no-half-open enforcer
function onend() {
  // if we allow half-open state, or if the writable side ended,
  // then we're ok.
  if (this.allowHalfOpen || this._writableState.ended) return;

  // no more data can be written.
  // But allow more writes to happen in this tick.
  processNextTick(onEndNT, this);
}

function onEndNT(self) {
  self.end();
}

function forEach(xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}
},{"./_stream_readable":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_readable.js","./_stream_writable":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_writable.js","core-util-is":"/Users/jorge/provident/aragon/.metamask/node_modules/core-util-is/lib/util.js","inherits":"/Users/jorge/provident/aragon/.metamask/node_modules/inherits/inherits_browser.js","process-nextick-args":"/Users/jorge/provident/aragon/.metamask/node_modules/process-nextick-args/index.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_passthrough.js":[function(_dereq_,module,exports){
// a passthrough stream.
// basically just the most minimal sort of Transform stream.
// Every written chunk gets output as-is.

'use strict';

module.exports = PassThrough;

var Transform = _dereq_('./_stream_transform');

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

util.inherits(PassThrough, Transform);

function PassThrough(options) {
  if (!(this instanceof PassThrough)) return new PassThrough(options);

  Transform.call(this, options);
}

PassThrough.prototype._transform = function (chunk, encoding, cb) {
  cb(null, chunk);
};
},{"./_stream_transform":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_transform.js","core-util-is":"/Users/jorge/provident/aragon/.metamask/node_modules/core-util-is/lib/util.js","inherits":"/Users/jorge/provident/aragon/.metamask/node_modules/inherits/inherits_browser.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_readable.js":[function(_dereq_,module,exports){
(function (process){
'use strict';

module.exports = Readable;

/*<replacement>*/
var processNextTick = _dereq_('process-nextick-args');
/*</replacement>*/

/*<replacement>*/
var isArray = _dereq_('isarray');
/*</replacement>*/

/*<replacement>*/
var Duplex;
/*</replacement>*/

Readable.ReadableState = ReadableState;

/*<replacement>*/
var EE = _dereq_('events').EventEmitter;

var EElistenerCount = function (emitter, type) {
  return emitter.listeners(type).length;
};
/*</replacement>*/

/*<replacement>*/
var Stream;
(function () {
  try {
    Stream = _dereq_('st' + 'ream');
  } catch (_) {} finally {
    if (!Stream) Stream = _dereq_('events').EventEmitter;
  }
})();
/*</replacement>*/

var Buffer = _dereq_('buffer').Buffer;
/*<replacement>*/
var bufferShim = _dereq_('buffer-shims');
/*</replacement>*/

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

/*<replacement>*/
var debugUtil = _dereq_('util');
var debug = void 0;
if (debugUtil && debugUtil.debuglog) {
  debug = debugUtil.debuglog('stream');
} else {
  debug = function () {};
}
/*</replacement>*/

var BufferList = _dereq_('./internal/streams/BufferList');
var StringDecoder;

util.inherits(Readable, Stream);

function prependListener(emitter, event, fn) {
  // Sadly this is not cacheable as some libraries bundle their own
  // event emitter implementation with them.
  if (typeof emitter.prependListener === 'function') {
    return emitter.prependListener(event, fn);
  } else {
    // This is a hack to make sure that our error handler is attached before any
    // userland ones.  NEVER DO THIS. This is here only because this code needs
    // to continue to work with older versions of Node.js that do not include
    // the prependListener() method. The goal is to eventually remove this hack.
    if (!emitter._events || !emitter._events[event]) emitter.on(event, fn);else if (isArray(emitter._events[event])) emitter._events[event].unshift(fn);else emitter._events[event] = [fn, emitter._events[event]];
  }
}

function ReadableState(options, stream) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  options = options || {};

  // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex) this.objectMode = this.objectMode || !!options.readableObjectMode;

  // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  var hwm = options.highWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = hwm || hwm === 0 ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~ ~this.highWaterMark;

  // A linked list is used to store data chunks instead of an array because the
  // linked list can remove elements from the beginning faster than
  // array.shift()
  this.buffer = new BufferList();
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;
  this.resumeScheduled = false;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // when piping, we only care about 'readable' events that happen
  // after read()ing all the bytes and not getting any pushback.
  this.ranOut = false;

  // the number of writers that are awaiting a drain event in .pipe()s
  this.awaitDrain = 0;

  // if true, a maybeReadMore has been scheduled
  this.readingMore = false;

  this.decoder = null;
  this.encoding = null;
  if (options.encoding) {
    if (!StringDecoder) StringDecoder = _dereq_('string_decoder/').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

function Readable(options) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  if (!(this instanceof Readable)) return new Readable(options);

  this._readableState = new ReadableState(options, this);

  // legacy
  this.readable = true;

  if (options && typeof options.read === 'function') this._read = options.read;

  Stream.call(this);
}

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function (chunk, encoding) {
  var state = this._readableState;

  if (!state.objectMode && typeof chunk === 'string') {
    encoding = encoding || state.defaultEncoding;
    if (encoding !== state.encoding) {
      chunk = bufferShim.from(chunk, encoding);
      encoding = '';
    }
  }

  return readableAddChunk(this, state, chunk, encoding, false);
};

// Unshift should *always* be something directly out of read()
Readable.prototype.unshift = function (chunk) {
  var state = this._readableState;
  return readableAddChunk(this, state, chunk, '', true);
};

Readable.prototype.isPaused = function () {
  return this._readableState.flowing === false;
};

function readableAddChunk(stream, state, chunk, encoding, addToFront) {
  var er = chunkInvalid(state, chunk);
  if (er) {
    stream.emit('error', er);
  } else if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else if (state.objectMode || chunk && chunk.length > 0) {
    if (state.ended && !addToFront) {
      var e = new Error('stream.push() after EOF');
      stream.emit('error', e);
    } else if (state.endEmitted && addToFront) {
      var _e = new Error('stream.unshift() after end event');
      stream.emit('error', _e);
    } else {
      var skipAdd;
      if (state.decoder && !addToFront && !encoding) {
        chunk = state.decoder.write(chunk);
        skipAdd = !state.objectMode && chunk.length === 0;
      }

      if (!addToFront) state.reading = false;

      // Don't add to the buffer if we've decoded to an empty string chunk and
      // we're not in object mode
      if (!skipAdd) {
        // if we want the data now, just emit it.
        if (state.flowing && state.length === 0 && !state.sync) {
          stream.emit('data', chunk);
          stream.read(0);
        } else {
          // update the buffer info.
          state.length += state.objectMode ? 1 : chunk.length;
          if (addToFront) state.buffer.unshift(chunk);else state.buffer.push(chunk);

          if (state.needReadable) emitReadable(stream);
        }
      }

      maybeReadMore(stream, state);
    }
  } else if (!addToFront) {
    state.reading = false;
  }

  return needMoreData(state);
}

// if it's past the high water mark, we can push in some more.
// Also, if we have no data yet, we can stand some
// more bytes.  This is to work around cases where hwm=0,
// such as the repl.  Also, if the push() triggered a
// readable event, and the user called read(largeNumber) such that
// needReadable was set, then we ought to push more, so that another
// 'readable' event will be triggered.
function needMoreData(state) {
  return !state.ended && (state.needReadable || state.length < state.highWaterMark || state.length === 0);
}

// backwards compatibility.
Readable.prototype.setEncoding = function (enc) {
  if (!StringDecoder) StringDecoder = _dereq_('string_decoder/').StringDecoder;
  this._readableState.decoder = new StringDecoder(enc);
  this._readableState.encoding = enc;
  return this;
};

// Don't raise the hwm > 8MB
var MAX_HWM = 0x800000;
function computeNewHighWaterMark(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2 to prevent increasing hwm excessively in
    // tiny amounts
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    n++;
  }
  return n;
}

// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function howMuchToRead(n, state) {
  if (n <= 0 || state.length === 0 && state.ended) return 0;
  if (state.objectMode) return 1;
  if (n !== n) {
    // Only flow one buffer at a time
    if (state.flowing && state.length) return state.buffer.head.data.length;else return state.length;
  }
  // If we're asking for more than the current hwm, then raise the hwm.
  if (n > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(n);
  if (n <= state.length) return n;
  // Don't have enough
  if (!state.ended) {
    state.needReadable = true;
    return 0;
  }
  return state.length;
}

// you can override either this method, or the async _read(n) below.
Readable.prototype.read = function (n) {
  debug('read', n);
  n = parseInt(n, 10);
  var state = this._readableState;
  var nOrig = n;

  if (n !== 0) state.emittedReadable = false;

  // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 && state.needReadable && (state.length >= state.highWaterMark || state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended) endReadable(this);else emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state);

  // if we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  var doRead = state.needReadable;
  debug('need readable', doRead);

  // if we currently have less than the highWaterMark, then also read some
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.
  if (state.ended || state.reading) {
    doRead = false;
    debug('reading or ended', doRead);
  } else if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true;
    // if the length is currently zero, then we *need* a readable event.
    if (state.length === 0) state.needReadable = true;
    // call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
    // If _read pushed data synchronously, then `reading` will be false,
    // and we need to re-evaluate how much data we can return to the user.
    if (!state.reading) n = howMuchToRead(nOrig, state);
  }

  var ret;
  if (n > 0) ret = fromList(n, state);else ret = null;

  if (ret === null) {
    state.needReadable = true;
    n = 0;
  } else {
    state.length -= n;
  }

  if (state.length === 0) {
    // If we have nothing in the buffer, then we want to know
    // as soon as we *do* get something into the buffer.
    if (!state.ended) state.needReadable = true;

    // If we tried to read() past the EOF, then emit end on the next tick.
    if (nOrig !== n && state.ended) endReadable(this);
  }

  if (ret !== null) this.emit('data', ret);

  return ret;
};

function chunkInvalid(state, chunk) {
  var er = null;
  if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && chunk !== null && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  return er;
}

function onEofChunk(stream, state) {
  if (state.ended) return;
  if (state.decoder) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  // emit 'readable' now to make sure it gets picked up.
  emitReadable(stream);
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  var state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    if (state.sync) processNextTick(emitReadable_, stream);else emitReadable_(stream);
  }
}

function emitReadable_(stream) {
  debug('emit readable');
  stream.emit('readable');
  flow(stream);
}

// at this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    processNextTick(maybeReadMore_, stream, state);
  }
}

function maybeReadMore_(stream, state) {
  var len = state.length;
  while (!state.reading && !state.flowing && !state.ended && state.length < state.highWaterMark) {
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // didn't get any data, stop spinning.
      break;else len = state.length;
  }
  state.readingMore = false;
}

// abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function (n) {
  this.emit('error', new Error('_read() is not implemented'));
};

Readable.prototype.pipe = function (dest, pipeOpts) {
  var src = this;
  var state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;
    case 1:
      state.pipes = [state.pipes, dest];
      break;
    default:
      state.pipes.push(dest);
      break;
  }
  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);

  var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;

  var endFn = doEnd ? onend : cleanup;
  if (state.endEmitted) processNextTick(endFn);else src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable) {
    debug('onunpipe');
    if (readable === src) {
      cleanup();
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.
  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);

  var cleanedUp = false;
  function cleanup() {
    debug('cleanup');
    // cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', cleanup);
    src.removeListener('data', ondata);

    cleanedUp = true;

    // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (state.awaitDrain && (!dest._writableState || dest._writableState.needDrain)) ondrain();
  }

  // If the user pushes more data while we're writing to dest then we'll end up
  // in ondata again. However, we only want to increase awaitDrain once because
  // dest will only emit one 'drain' event for the multiple writes.
  // => Introduce a guard on increasing awaitDrain.
  var increasedAwaitDrain = false;
  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    increasedAwaitDrain = false;
    var ret = dest.write(chunk);
    if (false === ret && !increasedAwaitDrain) {
      // If the user unpiped during `dest.write()`, it is possible
      // to get stuck in a permanently paused state if that write
      // also returned false.
      // => Check whether `dest` is still a piping destination.
      if ((state.pipesCount === 1 && state.pipes === dest || state.pipesCount > 1 && indexOf(state.pipes, dest) !== -1) && !cleanedUp) {
        debug('false write response, pause', src._readableState.awaitDrain);
        src._readableState.awaitDrain++;
        increasedAwaitDrain = true;
      }
      src.pause();
    }
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EElistenerCount(dest, 'error') === 0) dest.emit('error', er);
  }

  // Make sure our error handler is attached before userland ones.
  prependListener(dest, 'error', onerror);

  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // tell the dest that it's being piped to
  dest.emit('pipe', src);

  // start the flow if it hasn't been started already.
  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function () {
    var state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain) state.awaitDrain--;
    if (state.awaitDrain === 0 && EElistenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}

Readable.prototype.unpipe = function (dest) {
  var state = this._readableState;

  // if we're not piping anywhere, then do nothing.
  if (state.pipesCount === 0) return this;

  // just one destination.  most common case.
  if (state.pipesCount === 1) {
    // passed in one, but it's not the right one.
    if (dest && dest !== state.pipes) return this;

    if (!dest) dest = state.pipes;

    // got a match.
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest) dest.emit('unpipe', this);
    return this;
  }

  // slow case. multiple pipe destinations.

  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var i = 0; i < len; i++) {
      dests[i].emit('unpipe', this);
    }return this;
  }

  // try to find the right one.
  var index = indexOf(state.pipes, dest);
  if (index === -1) return this;

  state.pipes.splice(index, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1) state.pipes = state.pipes[0];

  dest.emit('unpipe', this);

  return this;
};

// set up data events if they are asked for
// Ensure readable listeners eventually get something
Readable.prototype.on = function (ev, fn) {
  var res = Stream.prototype.on.call(this, ev, fn);

  if (ev === 'data') {
    // Start flowing on next tick if stream isn't explicitly paused
    if (this._readableState.flowing !== false) this.resume();
  } else if (ev === 'readable') {
    var state = this._readableState;
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = state.needReadable = true;
      state.emittedReadable = false;
      if (!state.reading) {
        processNextTick(nReadingNextTick, this);
      } else if (state.length) {
        emitReadable(this, state);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

function nReadingNextTick(self) {
  debug('readable nexttick read 0');
  self.read(0);
}

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function () {
  var state = this._readableState;
  if (!state.flowing) {
    debug('resume');
    state.flowing = true;
    resume(this, state);
  }
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    processNextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  if (!state.reading) {
    debug('resume read 0');
    stream.read(0);
  }

  state.resumeScheduled = false;
  state.awaitDrain = 0;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading) stream.read(0);
}

Readable.prototype.pause = function () {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (false !== this._readableState.flowing) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  return this;
};

function flow(stream) {
  var state = stream._readableState;
  debug('flow', state.flowing);
  while (state.flowing && stream.read() !== null) {}
}

// wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function (stream) {
  var state = this._readableState;
  var paused = false;

  var self = this;
  stream.on('end', function () {
    debug('wrapped end');
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length) self.push(chunk);
    }

    self.push(null);
  });

  stream.on('data', function (chunk) {
    debug('wrapped data');
    if (state.decoder) chunk = state.decoder.write(chunk);

    // don't skip over falsy values in objectMode
    if (state.objectMode && (chunk === null || chunk === undefined)) return;else if (!state.objectMode && (!chunk || !chunk.length)) return;

    var ret = self.push(chunk);
    if (!ret) {
      paused = true;
      stream.pause();
    }
  });

  // proxy all the other methods.
  // important when wrapping filters and duplexes.
  for (var i in stream) {
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = function (method) {
        return function () {
          return stream[method].apply(stream, arguments);
        };
      }(i);
    }
  }

  // proxy certain important events.
  var events = ['error', 'close', 'destroy', 'pause', 'resume'];
  forEach(events, function (ev) {
    stream.on(ev, self.emit.bind(self, ev));
  });

  // when we try to consume some more bytes, simply unpause the
  // underlying stream.
  self._read = function (n) {
    debug('wrapped _read', n);
    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return self;
};

// exposed for testing purposes only.
Readable._fromList = fromList;

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromList(n, state) {
  // nothing buffered
  if (state.length === 0) return null;

  var ret;
  if (state.objectMode) ret = state.buffer.shift();else if (!n || n >= state.length) {
    // read it all, truncate the list
    if (state.decoder) ret = state.buffer.join('');else if (state.buffer.length === 1) ret = state.buffer.head.data;else ret = state.buffer.concat(state.length);
    state.buffer.clear();
  } else {
    // read part of list
    ret = fromListPartial(n, state.buffer, state.decoder);
  }

  return ret;
}

// Extracts only enough buffered data to satisfy the amount requested.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromListPartial(n, list, hasStrings) {
  var ret;
  if (n < list.head.data.length) {
    // slice is the same for buffers and strings
    ret = list.head.data.slice(0, n);
    list.head.data = list.head.data.slice(n);
  } else if (n === list.head.data.length) {
    // first chunk is a perfect match
    ret = list.shift();
  } else {
    // result spans more than one buffer
    ret = hasStrings ? copyFromBufferString(n, list) : copyFromBuffer(n, list);
  }
  return ret;
}

// Copies a specified amount of characters from the list of buffered data
// chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBufferString(n, list) {
  var p = list.head;
  var c = 1;
  var ret = p.data;
  n -= ret.length;
  while (p = p.next) {
    var str = p.data;
    var nb = n > str.length ? str.length : n;
    if (nb === str.length) ret += str;else ret += str.slice(0, n);
    n -= nb;
    if (n === 0) {
      if (nb === str.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = str.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

// Copies a specified amount of bytes from the list of buffered data chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBuffer(n, list) {
  var ret = bufferShim.allocUnsafe(n);
  var p = list.head;
  var c = 1;
  p.data.copy(ret);
  n -= p.data.length;
  while (p = p.next) {
    var buf = p.data;
    var nb = n > buf.length ? buf.length : n;
    buf.copy(ret, ret.length - n, 0, nb);
    n -= nb;
    if (n === 0) {
      if (nb === buf.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = buf.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

function endReadable(stream) {
  var state = stream._readableState;

  // If we get here before consuming all the bytes, then that is a
  // bug in node.  Should never happen.
  if (state.length > 0) throw new Error('"endReadable()" called on non-empty stream');

  if (!state.endEmitted) {
    state.ended = true;
    processNextTick(endReadableNT, state, stream);
  }
}

function endReadableNT(state, stream) {
  // Check that we didn't get one last unshift.
  if (!state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.readable = false;
    stream.emit('end');
  }
}

function forEach(xs, f) {
  for (var i = 0, l = xs.length; i < l; i++) {
    f(xs[i], i);
  }
}

function indexOf(xs, x) {
  for (var i = 0, l = xs.length; i < l; i++) {
    if (xs[i] === x) return i;
  }
  return -1;
}
}).call(this,_dereq_('_process'))

},{"./_stream_duplex":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_duplex.js","./internal/streams/BufferList":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/internal/streams/BufferList.js","_process":"/Users/jorge/provident/aragon/.metamask/node_modules/browserify/node_modules/process/browser.js","buffer":"/Users/jorge/provident/aragon/.metamask/node_modules/buffer/index.js","buffer-shims":"/Users/jorge/provident/aragon/.metamask/node_modules/buffer-shims/index.js","core-util-is":"/Users/jorge/provident/aragon/.metamask/node_modules/core-util-is/lib/util.js","events":"/Users/jorge/provident/aragon/.metamask/node_modules/events/events.js","inherits":"/Users/jorge/provident/aragon/.metamask/node_modules/inherits/inherits_browser.js","isarray":"/Users/jorge/provident/aragon/.metamask/node_modules/isarray/index.js","process-nextick-args":"/Users/jorge/provident/aragon/.metamask/node_modules/process-nextick-args/index.js","string_decoder/":"/Users/jorge/provident/aragon/.metamask/node_modules/string_decoder/index.js","util":"/Users/jorge/provident/aragon/.metamask/node_modules/browser-resolve/empty.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_transform.js":[function(_dereq_,module,exports){
// a transform stream is a readable/writable stream where you do
// something with the data.  Sometimes it's called a "filter",
// but that's not a great name for it, since that implies a thing where
// some bits pass through, and others are simply ignored.  (That would
// be a valid example of a transform, of course.)
//
// While the output is causally related to the input, it's not a
// necessarily symmetric or synchronous transformation.  For example,
// a zlib stream might take multiple plain-text writes(), and then
// emit a single compressed chunk some time in the future.
//
// Here's how this works:
//
// The Transform stream has all the aspects of the readable and writable
// stream classes.  When you write(chunk), that calls _write(chunk,cb)
// internally, and returns false if there's a lot of pending writes
// buffered up.  When you call read(), that calls _read(n) until
// there's enough pending readable data buffered up.
//
// In a transform stream, the written data is placed in a buffer.  When
// _read(n) is called, it transforms the queued up data, calling the
// buffered _write cb's as it consumes chunks.  If consuming a single
// written chunk would result in multiple output chunks, then the first
// outputted bit calls the readcb, and subsequent chunks just go into
// the read buffer, and will cause it to emit 'readable' if necessary.
//
// This way, back-pressure is actually determined by the reading side,
// since _read has to be called to start processing a new chunk.  However,
// a pathological inflate type of transform can cause excessive buffering
// here.  For example, imagine a stream where every byte of input is
// interpreted as an integer from 0-255, and then results in that many
// bytes of output.  Writing the 4 bytes {ff,ff,ff,ff} would result in
// 1kb of data being output.  In this case, you could write a very small
// amount of input, and end up with a very large amount of output.  In
// such a pathological inflating mechanism, there'd be no way to tell
// the system to stop doing the transform.  A single 4MB write could
// cause the system to run out of memory.
//
// However, even in such a pathological case, only a single written chunk
// would be consumed, and then the rest would wait (un-transformed) until
// the results of the previous transformed chunk were consumed.

'use strict';

module.exports = Transform;

var Duplex = _dereq_('./_stream_duplex');

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

util.inherits(Transform, Duplex);

function TransformState(stream) {
  this.afterTransform = function (er, data) {
    return afterTransform(stream, er, data);
  };

  this.needTransform = false;
  this.transforming = false;
  this.writecb = null;
  this.writechunk = null;
  this.writeencoding = null;
}

function afterTransform(stream, er, data) {
  var ts = stream._transformState;
  ts.transforming = false;

  var cb = ts.writecb;

  if (!cb) return stream.emit('error', new Error('no writecb in Transform class'));

  ts.writechunk = null;
  ts.writecb = null;

  if (data !== null && data !== undefined) stream.push(data);

  cb(er);

  var rs = stream._readableState;
  rs.reading = false;
  if (rs.needReadable || rs.length < rs.highWaterMark) {
    stream._read(rs.highWaterMark);
  }
}

function Transform(options) {
  if (!(this instanceof Transform)) return new Transform(options);

  Duplex.call(this, options);

  this._transformState = new TransformState(this);

  var stream = this;

  // start out asking for a readable event once data is transformed.
  this._readableState.needReadable = true;

  // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  if (options) {
    if (typeof options.transform === 'function') this._transform = options.transform;

    if (typeof options.flush === 'function') this._flush = options.flush;
  }

  // When the writable side finishes, then flush out anything remaining.
  this.once('prefinish', function () {
    if (typeof this._flush === 'function') this._flush(function (er, data) {
      done(stream, er, data);
    });else done(stream);
  });
}

Transform.prototype.push = function (chunk, encoding) {
  this._transformState.needTransform = false;
  return Duplex.prototype.push.call(this, chunk, encoding);
};

// This is the part where you do stuff!
// override this function in implementation classes.
// 'chunk' is an input chunk.
//
// Call `push(newChunk)` to pass along transformed output
// to the readable side.  You may call 'push' zero or more times.
//
// Call `cb(err)` when you are done with this chunk.  If you pass
// an error, then that'll put the hurt on the whole operation.  If you
// never call cb(), then you'll never get another chunk.
Transform.prototype._transform = function (chunk, encoding, cb) {
  throw new Error('_transform() is not implemented');
};

Transform.prototype._write = function (chunk, encoding, cb) {
  var ts = this._transformState;
  ts.writecb = cb;
  ts.writechunk = chunk;
  ts.writeencoding = encoding;
  if (!ts.transforming) {
    var rs = this._readableState;
    if (ts.needTransform || rs.needReadable || rs.length < rs.highWaterMark) this._read(rs.highWaterMark);
  }
};

// Doesn't matter what the args are here.
// _transform does all the work.
// That we got here means that the readable side wants more data.
Transform.prototype._read = function (n) {
  var ts = this._transformState;

  if (ts.writechunk !== null && ts.writecb && !ts.transforming) {
    ts.transforming = true;
    this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
  } else {
    // mark that we need a transform, so that any data that comes in
    // will get processed, now that we've asked for it.
    ts.needTransform = true;
  }
};

function done(stream, er, data) {
  if (er) return stream.emit('error', er);

  if (data !== null && data !== undefined) stream.push(data);

  // if there's nothing in the write buffer, then that means
  // that nothing more will ever be provided
  var ws = stream._writableState;
  var ts = stream._transformState;

  if (ws.length) throw new Error('Calling transform done when ws.length != 0');

  if (ts.transforming) throw new Error('Calling transform done when still transforming');

  return stream.push(null);
}
},{"./_stream_duplex":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_duplex.js","core-util-is":"/Users/jorge/provident/aragon/.metamask/node_modules/core-util-is/lib/util.js","inherits":"/Users/jorge/provident/aragon/.metamask/node_modules/inherits/inherits_browser.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_writable.js":[function(_dereq_,module,exports){
(function (process){
// A bit simpler than readable streams.
// Implement an async ._write(chunk, encoding, cb), and it'll handle all
// the drain event emission and buffering.

'use strict';

module.exports = Writable;

/*<replacement>*/
var processNextTick = _dereq_('process-nextick-args');
/*</replacement>*/

/*<replacement>*/
var asyncWrite = !process.browser && ['v0.10', 'v0.9.'].indexOf(process.version.slice(0, 5)) > -1 ? setImmediate : processNextTick;
/*</replacement>*/

/*<replacement>*/
var Duplex;
/*</replacement>*/

Writable.WritableState = WritableState;

/*<replacement>*/
var util = _dereq_('core-util-is');
util.inherits = _dereq_('inherits');
/*</replacement>*/

/*<replacement>*/
var internalUtil = {
  deprecate: _dereq_('util-deprecate')
};
/*</replacement>*/

/*<replacement>*/
var Stream;
(function () {
  try {
    Stream = _dereq_('st' + 'ream');
  } catch (_) {} finally {
    if (!Stream) Stream = _dereq_('events').EventEmitter;
  }
})();
/*</replacement>*/

var Buffer = _dereq_('buffer').Buffer;
/*<replacement>*/
var bufferShim = _dereq_('buffer-shims');
/*</replacement>*/

util.inherits(Writable, Stream);

function nop() {}

function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
  this.next = null;
}

function WritableState(options, stream) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  options = options || {};

  // object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!options.objectMode;

  if (stream instanceof Duplex) this.objectMode = this.objectMode || !!options.writableObjectMode;

  // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()
  var hwm = options.highWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;
  this.highWaterMark = hwm || hwm === 0 ? hwm : defaultHwm;

  // cast to ints.
  this.highWaterMark = ~ ~this.highWaterMark;

  // drain event flag.
  this.needDrain = false;
  // at the start of calling end()
  this.ending = false;
  // when end() has been called, and returned
  this.ended = false;
  // when 'finish' is emitted
  this.finished = false;

  // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  var noDecode = options.decodeStrings === false;
  this.decodeStrings = !noDecode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  this.length = 0;

  // a flag to see when we're in the middle of a write.
  this.writing = false;

  // when true all writes will be buffered until .uncork() call
  this.corked = 0;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // a flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.
  this.bufferProcessing = false;

  // the callback that's passed to _write(chunk,cb)
  this.onwrite = function (er) {
    onwrite(stream, er);
  };

  // the callback that the user supplies to write(chunk,encoding,cb)
  this.writecb = null;

  // the amount that is being written when _write is called.
  this.writelen = 0;

  this.bufferedRequest = null;
  this.lastBufferedRequest = null;

  // number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted
  this.pendingcb = 0;

  // emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams
  this.prefinished = false;

  // True if the error was already emitted and should not be thrown again
  this.errorEmitted = false;

  // count buffered requests
  this.bufferedRequestCount = 0;

  // allocate the first CorkedRequest, there is always
  // one allocated and free to use, and we maintain at most two
  this.corkedRequestsFree = new CorkedRequest(this);
}

WritableState.prototype.getBuffer = function getBuffer() {
  var current = this.bufferedRequest;
  var out = [];
  while (current) {
    out.push(current);
    current = current.next;
  }
  return out;
};

(function () {
  try {
    Object.defineProperty(WritableState.prototype, 'buffer', {
      get: internalUtil.deprecate(function () {
        return this.getBuffer();
      }, '_writableState.buffer is deprecated. Use _writableState.getBuffer ' + 'instead.')
    });
  } catch (_) {}
})();

// Test _writableState for inheritance to account for Duplex streams,
// whose prototype chain only points to Readable.
var realHasInstance;
if (typeof Symbol === 'function' && Symbol.hasInstance && typeof Function.prototype[Symbol.hasInstance] === 'function') {
  realHasInstance = Function.prototype[Symbol.hasInstance];
  Object.defineProperty(Writable, Symbol.hasInstance, {
    value: function (object) {
      if (realHasInstance.call(this, object)) return true;

      return object && object._writableState instanceof WritableState;
    }
  });
} else {
  realHasInstance = function (object) {
    return object instanceof this;
  };
}

function Writable(options) {
  Duplex = Duplex || _dereq_('./_stream_duplex');

  // Writable ctor is applied to Duplexes, too.
  // `realHasInstance` is necessary because using plain `instanceof`
  // would return false, as no `_writableState` property is attached.

  // Trying to use the custom `instanceof` for Writable here will also break the
  // Node.js LazyTransform implementation, which has a non-trivial getter for
  // `_writableState` that would lead to infinite recursion.
  if (!realHasInstance.call(Writable, this) && !(this instanceof Duplex)) {
    return new Writable(options);
  }

  this._writableState = new WritableState(options, this);

  // legacy.
  this.writable = true;

  if (options) {
    if (typeof options.write === 'function') this._write = options.write;

    if (typeof options.writev === 'function') this._writev = options.writev;
  }

  Stream.call(this);
}

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function () {
  this.emit('error', new Error('Cannot pipe, not readable'));
};

function writeAfterEnd(stream, cb) {
  var er = new Error('write after end');
  // TODO: defer error events consistently everywhere, not just the cb
  stream.emit('error', er);
  processNextTick(cb, er);
}

// If we get something that is not a buffer, string, null, or undefined,
// and we're not in objectMode, then that's an error.
// Otherwise stream chunks are all considered to be of length=1, and the
// watermarks determine how many objects to keep in the buffer, rather than
// how many bytes or characters.
function validChunk(stream, state, chunk, cb) {
  var valid = true;
  var er = false;
  // Always throw error if a null is written
  // if we are not in object mode then throw
  // if it is not a buffer, string, or undefined.
  if (chunk === null) {
    er = new TypeError('May not write null values to stream');
  } else if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string' && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  if (er) {
    stream.emit('error', er);
    processNextTick(cb, er);
    valid = false;
  }
  return valid;
}

Writable.prototype.write = function (chunk, encoding, cb) {
  var state = this._writableState;
  var ret = false;

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (Buffer.isBuffer(chunk)) encoding = 'buffer';else if (!encoding) encoding = state.defaultEncoding;

  if (typeof cb !== 'function') cb = nop;

  if (state.ended) writeAfterEnd(this, cb);else if (validChunk(this, state, chunk, cb)) {
    state.pendingcb++;
    ret = writeOrBuffer(this, state, chunk, encoding, cb);
  }

  return ret;
};

Writable.prototype.cork = function () {
  var state = this._writableState;

  state.corked++;
};

Writable.prototype.uncork = function () {
  var state = this._writableState;

  if (state.corked) {
    state.corked--;

    if (!state.writing && !state.corked && !state.finished && !state.bufferProcessing && state.bufferedRequest) clearBuffer(this, state);
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
  // node::ParseEncoding() requires lower case.
  if (typeof encoding === 'string') encoding = encoding.toLowerCase();
  if (!(['hex', 'utf8', 'utf-8', 'ascii', 'binary', 'base64', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'raw'].indexOf((encoding + '').toLowerCase()) > -1)) throw new TypeError('Unknown encoding: ' + encoding);
  this._writableState.defaultEncoding = encoding;
  return this;
};

function decodeChunk(state, chunk, encoding) {
  if (!state.objectMode && state.decodeStrings !== false && typeof chunk === 'string') {
    chunk = bufferShim.from(chunk, encoding);
  }
  return chunk;
}

// if we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.
function writeOrBuffer(stream, state, chunk, encoding, cb) {
  chunk = decodeChunk(state, chunk, encoding);

  if (Buffer.isBuffer(chunk)) encoding = 'buffer';
  var len = state.objectMode ? 1 : chunk.length;

  state.length += len;

  var ret = state.length < state.highWaterMark;
  // we must ensure that previous needDrain will not be reset to false.
  if (!ret) state.needDrain = true;

  if (state.writing || state.corked) {
    var last = state.lastBufferedRequest;
    state.lastBufferedRequest = new WriteReq(chunk, encoding, cb);
    if (last) {
      last.next = state.lastBufferedRequest;
    } else {
      state.bufferedRequest = state.lastBufferedRequest;
    }
    state.bufferedRequestCount += 1;
  } else {
    doWrite(stream, state, false, len, chunk, encoding, cb);
  }

  return ret;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (writev) stream._writev(chunk, state.onwrite);else stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  --state.pendingcb;
  if (sync) processNextTick(cb, er);else cb(er);

  stream._writableState.errorEmitted = true;
  stream.emit('error', er);
}

function onwriteStateUpdate(state) {
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
}

function onwrite(stream, er) {
  var state = stream._writableState;
  var sync = state.sync;
  var cb = state.writecb;

  onwriteStateUpdate(state);

  if (er) onwriteError(stream, state, sync, er, cb);else {
    // Check if we're actually ready to finish, but don't emit yet
    var finished = needFinish(state);

    if (!finished && !state.corked && !state.bufferProcessing && state.bufferedRequest) {
      clearBuffer(stream, state);
    }

    if (sync) {
      /*<replacement>*/
      asyncWrite(afterWrite, stream, state, finished, cb);
      /*</replacement>*/
    } else {
        afterWrite(stream, state, finished, cb);
      }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished) onwriteDrain(stream, state);
  state.pendingcb--;
  cb();
  finishMaybe(stream, state);
}

// Must force callback to be called on nextTick, so that we don't
// emit 'drain' before the write() consumer gets the 'false' return
// value, and has a chance to attach a 'drain' listener.
function onwriteDrain(stream, state) {
  if (state.length === 0 && state.needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }
}

// if there's something in the buffer waiting, then process it
function clearBuffer(stream, state) {
  state.bufferProcessing = true;
  var entry = state.bufferedRequest;

  if (stream._writev && entry && entry.next) {
    // Fast case, write everything using _writev()
    var l = state.bufferedRequestCount;
    var buffer = new Array(l);
    var holder = state.corkedRequestsFree;
    holder.entry = entry;

    var count = 0;
    while (entry) {
      buffer[count] = entry;
      entry = entry.next;
      count += 1;
    }

    doWrite(stream, state, true, state.length, buffer, '', holder.finish);

    // doWrite is almost always async, defer these to save a bit of time
    // as the hot path ends with doWrite
    state.pendingcb++;
    state.lastBufferedRequest = null;
    if (holder.next) {
      state.corkedRequestsFree = holder.next;
      holder.next = null;
    } else {
      state.corkedRequestsFree = new CorkedRequest(state);
    }
  } else {
    // Slow case, write chunks one-by-one
    while (entry) {
      var chunk = entry.chunk;
      var encoding = entry.encoding;
      var cb = entry.callback;
      var len = state.objectMode ? 1 : chunk.length;

      doWrite(stream, state, false, len, chunk, encoding, cb);
      entry = entry.next;
      // if we didn't call the onwrite immediately, then
      // it means that we need to wait until it does.
      // also, that means that the chunk and cb are currently
      // being processed, so move the buffer counter past them.
      if (state.writing) {
        break;
      }
    }

    if (entry === null) state.lastBufferedRequest = null;
  }

  state.bufferedRequestCount = 0;
  state.bufferedRequest = entry;
  state.bufferProcessing = false;
}

Writable.prototype._write = function (chunk, encoding, cb) {
  cb(new Error('_write() is not implemented'));
};

Writable.prototype._writev = null;

Writable.prototype.end = function (chunk, encoding, cb) {
  var state = this._writableState;

  if (typeof chunk === 'function') {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);

  // .end() fully uncorks
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }

  // ignore unnecessary end() calls.
  if (!state.ending && !state.finished) endWritable(this, state, cb);
};

function needFinish(state) {
  return state.ending && state.length === 0 && state.bufferedRequest === null && !state.finished && !state.writing;
}

function prefinish(stream, state) {
  if (!state.prefinished) {
    state.prefinished = true;
    stream.emit('prefinish');
  }
}

function finishMaybe(stream, state) {
  var need = needFinish(state);
  if (need) {
    if (state.pendingcb === 0) {
      prefinish(stream, state);
      state.finished = true;
      stream.emit('finish');
    } else {
      prefinish(stream, state);
    }
  }
  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);
  if (cb) {
    if (state.finished) processNextTick(cb);else stream.once('finish', cb);
  }
  state.ended = true;
  stream.writable = false;
}

// It seems a linked list but it is not
// there will be only 2 of these for each stream
function CorkedRequest(state) {
  var _this = this;

  this.next = null;
  this.entry = null;

  this.finish = function (err) {
    var entry = _this.entry;
    _this.entry = null;
    while (entry) {
      var cb = entry.callback;
      state.pendingcb--;
      cb(err);
      entry = entry.next;
    }
    if (state.corkedRequestsFree) {
      state.corkedRequestsFree.next = _this;
    } else {
      state.corkedRequestsFree = _this;
    }
  };
}
}).call(this,_dereq_('_process'))

},{"./_stream_duplex":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_duplex.js","_process":"/Users/jorge/provident/aragon/.metamask/node_modules/browserify/node_modules/process/browser.js","buffer":"/Users/jorge/provident/aragon/.metamask/node_modules/buffer/index.js","buffer-shims":"/Users/jorge/provident/aragon/.metamask/node_modules/buffer-shims/index.js","core-util-is":"/Users/jorge/provident/aragon/.metamask/node_modules/core-util-is/lib/util.js","events":"/Users/jorge/provident/aragon/.metamask/node_modules/events/events.js","inherits":"/Users/jorge/provident/aragon/.metamask/node_modules/inherits/inherits_browser.js","process-nextick-args":"/Users/jorge/provident/aragon/.metamask/node_modules/process-nextick-args/index.js","util-deprecate":"/Users/jorge/provident/aragon/.metamask/node_modules/util-deprecate/browser.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/internal/streams/BufferList.js":[function(_dereq_,module,exports){
'use strict';

var Buffer = _dereq_('buffer').Buffer;
/*<replacement>*/
var bufferShim = _dereq_('buffer-shims');
/*</replacement>*/

module.exports = BufferList;

function BufferList() {
  this.head = null;
  this.tail = null;
  this.length = 0;
}

BufferList.prototype.push = function (v) {
  var entry = { data: v, next: null };
  if (this.length > 0) this.tail.next = entry;else this.head = entry;
  this.tail = entry;
  ++this.length;
};

BufferList.prototype.unshift = function (v) {
  var entry = { data: v, next: this.head };
  if (this.length === 0) this.tail = entry;
  this.head = entry;
  ++this.length;
};

BufferList.prototype.shift = function () {
  if (this.length === 0) return;
  var ret = this.head.data;
  if (this.length === 1) this.head = this.tail = null;else this.head = this.head.next;
  --this.length;
  return ret;
};

BufferList.prototype.clear = function () {
  this.head = this.tail = null;
  this.length = 0;
};

BufferList.prototype.join = function (s) {
  if (this.length === 0) return '';
  var p = this.head;
  var ret = '' + p.data;
  while (p = p.next) {
    ret += s + p.data;
  }return ret;
};

BufferList.prototype.concat = function (n) {
  if (this.length === 0) return bufferShim.alloc(0);
  if (this.length === 1) return this.head.data;
  var ret = bufferShim.allocUnsafe(n >>> 0);
  var p = this.head;
  var i = 0;
  while (p) {
    p.data.copy(ret, i);
    i += p.data.length;
    p = p.next;
  }
  return ret;
};
},{"buffer":"/Users/jorge/provident/aragon/.metamask/node_modules/buffer/index.js","buffer-shims":"/Users/jorge/provident/aragon/.metamask/node_modules/buffer-shims/index.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/passthrough.js":[function(_dereq_,module,exports){
module.exports = _dereq_("./lib/_stream_passthrough.js")

},{"./lib/_stream_passthrough.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_passthrough.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/readable.js":[function(_dereq_,module,exports){
(function (process){
var Stream = (function (){
  try {
    return _dereq_('st' + 'ream'); // hack to fix a circular dependency issue when used with browserify
  } catch(_){}
}());
exports = module.exports = _dereq_('./lib/_stream_readable.js');
exports.Stream = Stream || exports;
exports.Readable = exports;
exports.Writable = _dereq_('./lib/_stream_writable.js');
exports.Duplex = _dereq_('./lib/_stream_duplex.js');
exports.Transform = _dereq_('./lib/_stream_transform.js');
exports.PassThrough = _dereq_('./lib/_stream_passthrough.js');

if (!process.browser && process.env.READABLE_STREAM === 'disable' && Stream) {
  module.exports = Stream;
}

}).call(this,_dereq_('_process'))

},{"./lib/_stream_duplex.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_duplex.js","./lib/_stream_passthrough.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_passthrough.js","./lib/_stream_readable.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_readable.js","./lib/_stream_transform.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_transform.js","./lib/_stream_writable.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_writable.js","_process":"/Users/jorge/provident/aragon/.metamask/node_modules/browserify/node_modules/process/browser.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/transform.js":[function(_dereq_,module,exports){
module.exports = _dereq_("./lib/_stream_transform.js")

},{"./lib/_stream_transform.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_transform.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/writable.js":[function(_dereq_,module,exports){
module.exports = _dereq_("./lib/_stream_writable.js")

},{"./lib/_stream_writable.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/lib/_stream_writable.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/stream-browserify/index.js":[function(_dereq_,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

module.exports = Stream;

var EE = _dereq_('events').EventEmitter;
var inherits = _dereq_('inherits');

inherits(Stream, EE);
Stream.Readable = _dereq_('readable-stream/readable.js');
Stream.Writable = _dereq_('readable-stream/writable.js');
Stream.Duplex = _dereq_('readable-stream/duplex.js');
Stream.Transform = _dereq_('readable-stream/transform.js');
Stream.PassThrough = _dereq_('readable-stream/passthrough.js');

// Backwards-compat with node 0.4.x
Stream.Stream = Stream;



// old-style streams.  Note that the pipe method (the only relevant
// part of this class) is overridden in the Readable class.

function Stream() {
  EE.call(this);
}

Stream.prototype.pipe = function(dest, options) {
  var source = this;

  function ondata(chunk) {
    if (dest.writable) {
      if (false === dest.write(chunk) && source.pause) {
        source.pause();
      }
    }
  }

  source.on('data', ondata);

  function ondrain() {
    if (source.readable && source.resume) {
      source.resume();
    }
  }

  dest.on('drain', ondrain);

  // If the 'end' option is not supplied, dest.end() will be called when
  // source gets the 'end' or 'close' events.  Only dest.end() once.
  if (!dest._isStdio && (!options || options.end !== false)) {
    source.on('end', onend);
    source.on('close', onclose);
  }

  var didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;

    dest.end();
  }


  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;

    if (typeof dest.destroy === 'function') dest.destroy();
  }

  // don't leave dangling pipes when there are errors.
  function onerror(er) {
    cleanup();
    if (EE.listenerCount(this, 'error') === 0) {
      throw er; // Unhandled stream error in pipe.
    }
  }

  source.on('error', onerror);
  dest.on('error', onerror);

  // remove all the event listeners that were added.
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);

    source.removeListener('end', onend);
    source.removeListener('close', onclose);

    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);

    source.removeListener('end', cleanup);
    source.removeListener('close', cleanup);

    dest.removeListener('close', cleanup);
  }

  source.on('end', cleanup);
  source.on('close', cleanup);

  dest.on('close', cleanup);

  dest.emit('pipe', source);

  // Allow for unix-like usage: A.pipe(B).pipe(C)
  return dest;
};

},{"events":"/Users/jorge/provident/aragon/.metamask/node_modules/events/events.js","inherits":"/Users/jorge/provident/aragon/.metamask/node_modules/inherits/inherits_browser.js","readable-stream/duplex.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/duplex.js","readable-stream/passthrough.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/passthrough.js","readable-stream/readable.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/readable.js","readable-stream/transform.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/transform.js","readable-stream/writable.js":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/writable.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/string_decoder/index.js":[function(_dereq_,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var Buffer = _dereq_('buffer').Buffer;

var isBufferEncoding = Buffer.isEncoding
  || function(encoding) {
       switch (encoding && encoding.toLowerCase()) {
         case 'hex': case 'utf8': case 'utf-8': case 'ascii': case 'binary': case 'base64': case 'ucs2': case 'ucs-2': case 'utf16le': case 'utf-16le': case 'raw': return true;
         default: return false;
       }
     }


function assertEncoding(encoding) {
  if (encoding && !isBufferEncoding(encoding)) {
    throw new Error('Unknown encoding: ' + encoding);
  }
}

// StringDecoder provides an interface for efficiently splitting a series of
// buffers into a series of JS strings without breaking apart multi-byte
// characters. CESU-8 is handled as part of the UTF-8 encoding.
//
// @TODO Handling all encodings inside a single object makes it very difficult
// to reason about this code, so it should be split up in the future.
// @TODO There should be a utf8-strict encoding that rejects invalid UTF-8 code
// points as used by CESU-8.
var StringDecoder = exports.StringDecoder = function(encoding) {
  this.encoding = (encoding || 'utf8').toLowerCase().replace(/[-_]/, '');
  assertEncoding(encoding);
  switch (this.encoding) {
    case 'utf8':
      // CESU-8 represents each of Surrogate Pair by 3-bytes
      this.surrogateSize = 3;
      break;
    case 'ucs2':
    case 'utf16le':
      // UTF-16 represents each of Surrogate Pair by 2-bytes
      this.surrogateSize = 2;
      this.detectIncompleteChar = utf16DetectIncompleteChar;
      break;
    case 'base64':
      // Base-64 stores 3 bytes in 4 chars, and pads the remainder.
      this.surrogateSize = 3;
      this.detectIncompleteChar = base64DetectIncompleteChar;
      break;
    default:
      this.write = passThroughWrite;
      return;
  }

  // Enough space to store all bytes of a single character. UTF-8 needs 4
  // bytes, but CESU-8 may require up to 6 (3 bytes per surrogate).
  this.charBuffer = new Buffer(6);
  // Number of bytes received for the current incomplete multi-byte character.
  this.charReceived = 0;
  // Number of bytes expected for the current incomplete multi-byte character.
  this.charLength = 0;
};


// write decodes the given buffer and returns it as JS string that is
// guaranteed to not contain any partial multi-byte characters. Any partial
// character found at the end of the buffer is buffered up, and will be
// returned when calling write again with the remaining bytes.
//
// Note: Converting a Buffer containing an orphan surrogate to a String
// currently works, but converting a String to a Buffer (via `new Buffer`, or
// Buffer#write) will replace incomplete surrogates with the unicode
// replacement character. See https://codereview.chromium.org/121173009/ .
StringDecoder.prototype.write = function(buffer) {
  var charStr = '';
  // if our last write ended with an incomplete multibyte character
  while (this.charLength) {
    // determine how many remaining bytes this buffer has to offer for this char
    var available = (buffer.length >= this.charLength - this.charReceived) ?
        this.charLength - this.charReceived :
        buffer.length;

    // add the new bytes to the char buffer
    buffer.copy(this.charBuffer, this.charReceived, 0, available);
    this.charReceived += available;

    if (this.charReceived < this.charLength) {
      // still not enough chars in this buffer? wait for more ...
      return '';
    }

    // remove bytes belonging to the current character from the buffer
    buffer = buffer.slice(available, buffer.length);

    // get the character that was split
    charStr = this.charBuffer.slice(0, this.charLength).toString(this.encoding);

    // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
    var charCode = charStr.charCodeAt(charStr.length - 1);
    if (charCode >= 0xD800 && charCode <= 0xDBFF) {
      this.charLength += this.surrogateSize;
      charStr = '';
      continue;
    }
    this.charReceived = this.charLength = 0;

    // if there are no more bytes in this buffer, just emit our char
    if (buffer.length === 0) {
      return charStr;
    }
    break;
  }

  // determine and set charLength / charReceived
  this.detectIncompleteChar(buffer);

  var end = buffer.length;
  if (this.charLength) {
    // buffer the incomplete character bytes we got
    buffer.copy(this.charBuffer, 0, buffer.length - this.charReceived, end);
    end -= this.charReceived;
  }

  charStr += buffer.toString(this.encoding, 0, end);

  var end = charStr.length - 1;
  var charCode = charStr.charCodeAt(end);
  // CESU-8: lead surrogate (D800-DBFF) is also the incomplete character
  if (charCode >= 0xD800 && charCode <= 0xDBFF) {
    var size = this.surrogateSize;
    this.charLength += size;
    this.charReceived += size;
    this.charBuffer.copy(this.charBuffer, size, 0, size);
    buffer.copy(this.charBuffer, 0, 0, size);
    return charStr.substring(0, end);
  }

  // or just emit the charStr
  return charStr;
};

// detectIncompleteChar determines if there is an incomplete UTF-8 character at
// the end of the given buffer. If so, it sets this.charLength to the byte
// length that character, and sets this.charReceived to the number of bytes
// that are available for this character.
StringDecoder.prototype.detectIncompleteChar = function(buffer) {
  // determine how many bytes we have to check at the end of this buffer
  var i = (buffer.length >= 3) ? 3 : buffer.length;

  // Figure out if one of the last i bytes of our buffer announces an
  // incomplete char.
  for (; i > 0; i--) {
    var c = buffer[buffer.length - i];

    // See http://en.wikipedia.org/wiki/UTF-8#Description

    // 110XXXXX
    if (i == 1 && c >> 5 == 0x06) {
      this.charLength = 2;
      break;
    }

    // 1110XXXX
    if (i <= 2 && c >> 4 == 0x0E) {
      this.charLength = 3;
      break;
    }

    // 11110XXX
    if (i <= 3 && c >> 3 == 0x1E) {
      this.charLength = 4;
      break;
    }
  }
  this.charReceived = i;
};

StringDecoder.prototype.end = function(buffer) {
  var res = '';
  if (buffer && buffer.length)
    res = this.write(buffer);

  if (this.charReceived) {
    var cr = this.charReceived;
    var buf = this.charBuffer;
    var enc = this.encoding;
    res += buf.slice(0, cr).toString(enc);
  }

  return res;
};

function passThroughWrite(buffer) {
  return buffer.toString(this.encoding);
}

function utf16DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 2;
  this.charLength = this.charReceived ? 2 : 0;
}

function base64DetectIncompleteChar(buffer) {
  this.charReceived = buffer.length % 3;
  this.charLength = this.charReceived ? 3 : 0;
}

},{"buffer":"/Users/jorge/provident/aragon/.metamask/node_modules/buffer/index.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/through2/through2.js":[function(_dereq_,module,exports){
(function (process){
var Transform = _dereq_('readable-stream/transform')
  , inherits  = _dereq_('util').inherits
  , xtend     = _dereq_('xtend')

function DestroyableTransform(opts) {
  Transform.call(this, opts)
  this._destroyed = false
}

inherits(DestroyableTransform, Transform)

DestroyableTransform.prototype.destroy = function(err) {
  if (this._destroyed) return
  this._destroyed = true
  
  var self = this
  process.nextTick(function() {
    if (err)
      self.emit('error', err)
    self.emit('close')
  })
}

// a noop _transform function
function noop (chunk, enc, callback) {
  callback(null, chunk)
}


// create a new export function, used by both the main export and
// the .ctor export, contains common logic for dealing with arguments
function through2 (construct) {
  return function (options, transform, flush) {
    if (typeof options == 'function') {
      flush     = transform
      transform = options
      options   = {}
    }

    if (typeof transform != 'function')
      transform = noop

    if (typeof flush != 'function')
      flush = null

    return construct(options, transform, flush)
  }
}


// main export, just make me a transform stream!
module.exports = through2(function (options, transform, flush) {
  var t2 = new DestroyableTransform(options)

  t2._transform = transform

  if (flush)
    t2._flush = flush

  return t2
})


// make me a reusable prototype that I can `new`, or implicitly `new`
// with a constructor call
module.exports.ctor = through2(function (options, transform, flush) {
  function Through2 (override) {
    if (!(this instanceof Through2))
      return new Through2(override)

    this.options = xtend(options, override)

    DestroyableTransform.call(this, this.options)
  }

  inherits(Through2, DestroyableTransform)

  Through2.prototype._transform = transform

  if (flush)
    Through2.prototype._flush = flush

  return Through2
})


module.exports.obj = through2(function (options, transform, flush) {
  var t2 = new DestroyableTransform(xtend({ objectMode: true, highWaterMark: 16 }, options))

  t2._transform = transform

  if (flush)
    t2._flush = flush

  return t2
})

}).call(this,_dereq_('_process'))

},{"_process":"/Users/jorge/provident/aragon/.metamask/node_modules/browserify/node_modules/process/browser.js","readable-stream/transform":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/transform.js","util":"/Users/jorge/provident/aragon/.metamask/node_modules/util/util.js","xtend":"/Users/jorge/provident/aragon/.metamask/node_modules/xtend/immutable.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/util-deprecate/browser.js":[function(_dereq_,module,exports){
(function (global){

/**
 * Module exports.
 */

module.exports = deprecate;

/**
 * Mark that a method should not be used.
 * Returns a modified function which warns once by default.
 *
 * If `localStorage.noDeprecation = true` is set, then it is a no-op.
 *
 * If `localStorage.throwDeprecation = true` is set, then deprecated functions
 * will throw an Error when invoked.
 *
 * If `localStorage.traceDeprecation = true` is set, then deprecated functions
 * will invoke `console.trace()` instead of `console.error()`.
 *
 * @param {Function} fn - the function to deprecate
 * @param {String} msg - the string to print to the console when `fn` is invoked
 * @returns {Function} a new "deprecated" version of `fn`
 * @api public
 */

function deprecate (fn, msg) {
  if (config('noDeprecation')) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (config('throwDeprecation')) {
        throw new Error(msg);
      } else if (config('traceDeprecation')) {
        console.trace(msg);
      } else {
        console.warn(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
}

/**
 * Checks `localStorage` for boolean values for the given `name`.
 *
 * @param {String} name
 * @returns {Boolean}
 * @api private
 */

function config (name) {
  // accessing global.localStorage can trigger a DOMException in sandboxed iframes
  try {
    if (!global.localStorage) return false;
  } catch (_) {
    return false;
  }
  var val = global.localStorage[name];
  if (null == val) return false;
  return String(val).toLowerCase() === 'true';
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/util/node_modules/inherits/inherits_browser.js":[function(_dereq_,module,exports){
arguments[4]["/Users/jorge/provident/aragon/.metamask/node_modules/inherits/inherits_browser.js"][0].apply(exports,arguments)
},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/util/support/isBufferBrowser.js":[function(_dereq_,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/util/util.js":[function(_dereq_,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = _dereq_('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = _dereq_('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,_dereq_('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"./support/isBuffer":"/Users/jorge/provident/aragon/.metamask/node_modules/util/support/isBufferBrowser.js","_process":"/Users/jorge/provident/aragon/.metamask/node_modules/browserify/node_modules/process/browser.js","inherits":"/Users/jorge/provident/aragon/.metamask/node_modules/util/node_modules/inherits/inherits_browser.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/web3-stream-provider/index.js":[function(_dereq_,module,exports){
const Duplex = _dereq_('readable-stream').Duplex
const inherits = _dereq_('util').inherits

module.exports = StreamProvider


inherits(StreamProvider, Duplex)

function StreamProvider(){
  Duplex.call(this, {
    objectMode: true,
  })

  this._payloads = {}
}

// public

StreamProvider.prototype.send = function(payload){
  throw new Error('StreamProvider - does not support synchronous RPC calls. called: "'+payload.method+'"')
}

StreamProvider.prototype.sendAsync = function(payload, callback){
  // console.log('StreamProvider - sending payload', payload)
  var id = payload.id
  // handle batch requests
  if (Array.isArray(payload)) {
    // short circuit for empty batch requests
    if (payload.length === 0){
      return callback(null, [])
    }
    id = generateBatchId(payload)
  }
  // store request details
  this._payloads[id] = [payload, callback]
  // console.log('payload for plugin:', payload)
  this.push(payload)
}

StreamProvider.prototype.isConnected = function(){
  return true
}

// private

StreamProvider.prototype._onResponse = function(response){
  // console.log('StreamProvider - got response', payload)
  var id = response.id
  // handle batch requests
  if (Array.isArray(response)) {
    id = generateBatchId(response)
  }
  var data = this._payloads[id]
  if (!data) throw new Error('StreamProvider - Unknown response id')
  delete this._payloads[id]
  var payload = data[0]
  var callback = data[1]

  // logging
  // var res = Array.isArray(response) ? response : [response]
  // ;(Array.isArray(payload) ? payload : [payload]).forEach(function(payload, index){
  //   console.log('plugin response:', payload.id, payload.method, payload.params, '->', res[index].result)
  // })

  // run callback on empty stack,
  // prevent internal stream-handler from catching errors
  setTimeout(function(){
    callback(null, response)
  })
}

// stream plumbing

StreamProvider.prototype._read = noop

StreamProvider.prototype._write = function(msg, encoding, cb){
  this._onResponse(msg)
  cb()
}

// util

function generateBatchId(batchPayload){
  return 'batch:'+batchPayload.map(function(payload){ return payload.id }).join(',')
}

function noop(){}

},{"readable-stream":"/Users/jorge/provident/aragon/.metamask/node_modules/readable-stream/readable.js","util":"/Users/jorge/provident/aragon/.metamask/node_modules/util/util.js"}],"/Users/jorge/provident/aragon/.metamask/node_modules/web3/dist/web3.min.js":[function(_dereq_,module,exports){
(function (global){
_dereq_=function t(e,n,r){function o(a,s){if(!n[a]){if(!e[a]){var c="function"==typeof _dereq_&&_dereq_;if(!s&&c)return c(a,!0);if(i)return i(a,!0);var u=new Error("Cannot find module '"+a+"'");throw u.code="MODULE_NOT_FOUND",u}var f=n[a]={exports:{}};e[a][0].call(f.exports,function(t){var n=e[a][1][t];return o(n?n:t)},f,f.exports,t,e,n,r)}return n[a].exports}for(var i="function"==typeof _dereq_&&_dereq_,a=0;a<r.length;a++)o(r[a]);return o}({1:[function(t,e,n){e.exports=[{constant:!0,inputs:[{name:"_owner",type:"address"}],name:"name",outputs:[{name:"o_name",type:"bytes32"}],type:"function"},{constant:!0,inputs:[{name:"_name",type:"bytes32"}],name:"owner",outputs:[{name:"",type:"address"}],type:"function"},{constant:!0,inputs:[{name:"_name",type:"bytes32"}],name:"content",outputs:[{name:"",type:"bytes32"}],type:"function"},{constant:!0,inputs:[{name:"_name",type:"bytes32"}],name:"addr",outputs:[{name:"",type:"address"}],type:"function"},{constant:!1,inputs:[{name:"_name",type:"bytes32"}],name:"reserve",outputs:[],type:"function"},{constant:!0,inputs:[{name:"_name",type:"bytes32"}],name:"subRegistrar",outputs:[{name:"",type:"address"}],type:"function"},{constant:!1,inputs:[{name:"_name",type:"bytes32"},{name:"_newOwner",type:"address"}],name:"transfer",outputs:[],type:"function"},{constant:!1,inputs:[{name:"_name",type:"bytes32"},{name:"_registrar",type:"address"}],name:"setSubRegistrar",outputs:[],type:"function"},{constant:!1,inputs:[],name:"Registrar",outputs:[],type:"function"},{constant:!1,inputs:[{name:"_name",type:"bytes32"},{name:"_a",type:"address"},{name:"_primary",type:"bool"}],name:"setAddress",outputs:[],type:"function"},{constant:!1,inputs:[{name:"_name",type:"bytes32"},{name:"_content",type:"bytes32"}],name:"setContent",outputs:[],type:"function"},{constant:!1,inputs:[{name:"_name",type:"bytes32"}],name:"disown",outputs:[],type:"function"},{anonymous:!1,inputs:[{indexed:!0,name:"_name",type:"bytes32"},{indexed:!1,name:"_winner",type:"address"}],name:"AuctionEnded",type:"event"},{anonymous:!1,inputs:[{indexed:!0,name:"_name",type:"bytes32"},{indexed:!1,name:"_bidder",type:"address"},{indexed:!1,name:"_value",type:"uint256"}],name:"NewBid",type:"event"},{anonymous:!1,inputs:[{indexed:!0,name:"name",type:"bytes32"}],name:"Changed",type:"event"},{anonymous:!1,inputs:[{indexed:!0,name:"name",type:"bytes32"},{indexed:!0,name:"addr",type:"address"}],name:"PrimaryChanged",type:"event"}]},{}],2:[function(t,e,n){e.exports=[{constant:!0,inputs:[{name:"_name",type:"bytes32"}],name:"owner",outputs:[{name:"",type:"address"}],type:"function"},{constant:!1,inputs:[{name:"_name",type:"bytes32"},{name:"_refund",type:"address"}],name:"disown",outputs:[],type:"function"},{constant:!0,inputs:[{name:"_name",type:"bytes32"}],name:"addr",outputs:[{name:"",type:"address"}],type:"function"},{constant:!1,inputs:[{name:"_name",type:"bytes32"}],name:"reserve",outputs:[],type:"function"},{constant:!1,inputs:[{name:"_name",type:"bytes32"},{name:"_newOwner",type:"address"}],name:"transfer",outputs:[],type:"function"},{constant:!1,inputs:[{name:"_name",type:"bytes32"},{name:"_a",type:"address"}],name:"setAddr",outputs:[],type:"function"},{anonymous:!1,inputs:[{indexed:!0,name:"name",type:"bytes32"}],name:"Changed",type:"event"}]},{}],3:[function(t,e,n){e.exports=[{constant:!1,inputs:[{name:"from",type:"bytes32"},{name:"to",type:"address"},{name:"value",type:"uint256"}],name:"transfer",outputs:[],type:"function"},{constant:!1,inputs:[{name:"from",type:"bytes32"},{name:"to",type:"address"},{name:"indirectId",type:"bytes32"},{name:"value",type:"uint256"}],name:"icapTransfer",outputs:[],type:"function"},{constant:!1,inputs:[{name:"to",type:"bytes32"}],name:"deposit",outputs:[],payable:!0,type:"function"},{anonymous:!1,inputs:[{indexed:!0,name:"from",type:"address"},{indexed:!1,name:"value",type:"uint256"}],name:"AnonymousDeposit",type:"event"},{anonymous:!1,inputs:[{indexed:!0,name:"from",type:"address"},{indexed:!0,name:"to",type:"bytes32"},{indexed:!1,name:"value",type:"uint256"}],name:"Deposit",type:"event"},{anonymous:!1,inputs:[{indexed:!0,name:"from",type:"bytes32"},{indexed:!0,name:"to",type:"address"},{indexed:!1,name:"value",type:"uint256"}],name:"Transfer",type:"event"},{anonymous:!1,inputs:[{indexed:!0,name:"from",type:"bytes32"},{indexed:!0,name:"to",type:"address"},{indexed:!1,name:"indirectId",type:"bytes32"},{indexed:!1,name:"value",type:"uint256"}],name:"IcapTransfer",type:"event"}]},{}],4:[function(t,e,n){var r=t("./formatters"),o=t("./type"),i=function(){this._inputFormatter=r.formatInputInt,this._outputFormatter=r.formatOutputAddress};i.prototype=new o({}),i.prototype.constructor=i,i.prototype.isType=function(t){return!!t.match(/address(\[([0-9]*)\])?/)},e.exports=i},{"./formatters":9,"./type":14}],5:[function(t,e,n){var r=t("./formatters"),o=t("./type"),i=function(){this._inputFormatter=r.formatInputBool,this._outputFormatter=r.formatOutputBool};i.prototype=new o({}),i.prototype.constructor=i,i.prototype.isType=function(t){return!!t.match(/^bool(\[([0-9]*)\])*$/)},e.exports=i},{"./formatters":9,"./type":14}],6:[function(t,e,n){var r=t("./formatters"),o=t("./type"),i=function(){this._inputFormatter=r.formatInputBytes,this._outputFormatter=r.formatOutputBytes};i.prototype=new o({}),i.prototype.constructor=i,i.prototype.isType=function(t){return!!t.match(/^bytes([0-9]{1,})(\[([0-9]*)\])*$/)},e.exports=i},{"./formatters":9,"./type":14}],7:[function(t,e,n){var r=t("./formatters"),o=t("./address"),i=t("./bool"),a=t("./int"),s=t("./uint"),c=t("./dynamicbytes"),u=t("./string"),f=t("./real"),l=t("./ureal"),p=t("./bytes"),h=function(t,e){return t.isDynamicType(e)||t.isDynamicArray(e)},d=function(t){this._types=t};d.prototype._requireType=function(t){var e=this._types.filter(function(e){return e.isType(t)})[0];if(!e)throw Error("invalid solidity type!: "+t);return e},d.prototype.encodeParam=function(t,e){return this.encodeParams([t],[e])},d.prototype.encodeParams=function(t,e){var n=this.getSolidityTypes(t),r=n.map(function(n,r){return n.encode(e[r],t[r])}),o=n.reduce(function(e,r,o){var i=r.staticPartLength(t[o]),a=32*Math.floor((i+31)/32);return e+(h(n[o],t[o])?32:a)},0),i=this.encodeMultiWithOffset(t,n,r,o);return i},d.prototype.encodeMultiWithOffset=function(t,e,n,o){var i="",a=this;return t.forEach(function(s,c){if(h(e[c],t[c])){i+=r.formatInputInt(o).encode();var u=a.encodeWithOffset(t[c],e[c],n[c],o);o+=u.length/2}else i+=a.encodeWithOffset(t[c],e[c],n[c],o)}),t.forEach(function(r,s){if(h(e[s],t[s])){var c=a.encodeWithOffset(t[s],e[s],n[s],o);o+=c.length/2,i+=c}}),i},d.prototype.encodeWithOffset=function(t,e,n,o){var i=this;return e.isDynamicArray(t)?function(){var a=e.nestedName(t),s=e.staticPartLength(a),c=n[0];return function(){var t=2;if(e.isDynamicArray(a))for(var i=1;i<n.length;i++)t+=+n[i-1][0]||0,c+=r.formatInputInt(o+i*s+32*t).encode()}(),function(){for(var t=0;t<n.length-1;t++){var r=c/2;c+=i.encodeWithOffset(a,e,n[t+1],o+r)}}(),c}():e.isStaticArray(t)?function(){var a=e.nestedName(t),s=e.staticPartLength(a),c="";return e.isDynamicArray(a)&&!function(){for(var t=0,e=0;e<n.length;e++)t+=+(n[e-1]||[])[0]||0,c+=r.formatInputInt(o+e*s+32*t).encode()}(),function(){for(var t=0;t<n.length;t++){var r=c/2;c+=i.encodeWithOffset(a,e,n[t],o+r)}}(),c}():n},d.prototype.decodeParam=function(t,e){return this.decodeParams([t],e)[0]},d.prototype.decodeParams=function(t,e){var n=this.getSolidityTypes(t),r=this.getOffsets(t,n);return n.map(function(n,o){return n.decode(e,r[o],t[o],o)})},d.prototype.getOffsets=function(t,e){for(var n=e.map(function(e,n){return e.staticPartLength(t[n])}),r=1;r<n.length;r++)n[r]+=n[r-1];return n.map(function(n,r){var o=e[r].staticPartLength(t[r]);return n-o})},d.prototype.getSolidityTypes=function(t){var e=this;return t.map(function(t){return e._requireType(t)})};var m=new d([new o,new i,new a,new s,new c,new p,new u,new f,new l]);e.exports=m},{"./address":4,"./bool":5,"./bytes":6,"./dynamicbytes":8,"./formatters":9,"./int":10,"./real":12,"./string":13,"./uint":15,"./ureal":16}],8:[function(t,e,n){var r=t("./formatters"),o=t("./type"),i=function(){this._inputFormatter=r.formatInputDynamicBytes,this._outputFormatter=r.formatOutputDynamicBytes};i.prototype=new o({}),i.prototype.constructor=i,i.prototype.isType=function(t){return!!t.match(/^bytes(\[([0-9]*)\])*$/)},i.prototype.isDynamicType=function(){return!0},e.exports=i},{"./formatters":9,"./type":14}],9:[function(t,e,n){var r=t("bignumber.js"),o=t("../utils/utils"),i=t("../utils/config"),a=t("./param"),s=function(t){r.config(i.ETH_BIGNUMBER_ROUNDING_MODE);var e=o.padLeft(o.toTwosComplement(t).toString(16),64);return new a(e)},c=function(t){var e=o.toHex(t).substr(2),n=Math.floor((e.length+63)/64);return e=o.padRight(e,64*n),new a(e)},u=function(t){var e=o.toHex(t).substr(2),n=e.length/2,r=Math.floor((e.length+63)/64);return e=o.padRight(e,64*r),new a(s(n).value+e)},f=function(t){var e=o.fromUtf8(t).substr(2),n=e.length/2,r=Math.floor((e.length+63)/64);return e=o.padRight(e,64*r),new a(s(n).value+e)},l=function(t){var e="000000000000000000000000000000000000000000000000000000000000000"+(t?"1":"0");return new a(e)},p=function(t){return s(new r(t).times(new r(2).pow(128)))},h=function(t){return"1"===new r(t.substr(0,1),16).toString(2).substr(0,1)},d=function(t){var e=t.staticPart()||"0";return h(e)?new r(e,16).minus(new r("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",16)).minus(1):new r(e,16)},m=function(t){var e=t.staticPart()||"0";return new r(e,16)},y=function(t){return d(t).dividedBy(new r(2).pow(128))},g=function(t){return m(t).dividedBy(new r(2).pow(128))},v=function(t){return"0000000000000000000000000000000000000000000000000000000000000001"===t.staticPart()},b=function(t,e){var n=e.match(/^bytes([0-9]*)/),r=parseInt(n[1]);return"0x"+t.staticPart().slice(0,2*r)},_=function(t){var e=2*new r(t.dynamicPart().slice(0,64),16).toNumber();return"0x"+t.dynamicPart().substr(64,e)},w=function(t){var e=2*new r(t.dynamicPart().slice(0,64),16).toNumber();return o.toUtf8(t.dynamicPart().substr(64,e))},x=function(t){var e=t.staticPart();return"0x"+e.slice(e.length-40,e.length)};e.exports={formatInputInt:s,formatInputBytes:c,formatInputDynamicBytes:u,formatInputString:f,formatInputBool:l,formatInputReal:p,formatOutputInt:d,formatOutputUInt:m,formatOutputReal:y,formatOutputUReal:g,formatOutputBool:v,formatOutputBytes:b,formatOutputDynamicBytes:_,formatOutputString:w,formatOutputAddress:x}},{"../utils/config":18,"../utils/utils":20,"./param":11,"bignumber.js":"bignumber.js"}],10:[function(t,e,n){var r=t("./formatters"),o=t("./type"),i=function(){this._inputFormatter=r.formatInputInt,this._outputFormatter=r.formatOutputInt};i.prototype=new o({}),i.prototype.constructor=i,i.prototype.isType=function(t){return!!t.match(/^int([0-9]*)?(\[([0-9]*)\])*$/)},e.exports=i},{"./formatters":9,"./type":14}],11:[function(t,e,n){var r=t("../utils/utils"),o=function(t,e){this.value=t||"",this.offset=e};o.prototype.dynamicPartLength=function(){return this.dynamicPart().length/2},o.prototype.withOffset=function(t){return new o(this.value,t)},o.prototype.combine=function(t){return new o(this.value+t.value)},o.prototype.isDynamic=function(){return void 0!==this.offset},o.prototype.offsetAsBytes=function(){return this.isDynamic()?r.padLeft(r.toTwosComplement(this.offset).toString(16),64):""},o.prototype.staticPart=function(){return this.isDynamic()?this.offsetAsBytes():this.value},o.prototype.dynamicPart=function(){return this.isDynamic()?this.value:""},o.prototype.encode=function(){return this.staticPart()+this.dynamicPart()},o.encodeList=function(t){var e=32*t.length,n=t.map(function(t){if(!t.isDynamic())return t;var n=e;return e+=t.dynamicPartLength(),t.withOffset(n)});return n.reduce(function(t,e){return t+e.dynamicPart()},n.reduce(function(t,e){return t+e.staticPart()},""))},e.exports=o},{"../utils/utils":20}],12:[function(t,e,n){var r=t("./formatters"),o=t("./type"),i=function(){this._inputFormatter=r.formatInputReal,this._outputFormatter=r.formatOutputReal};i.prototype=new o({}),i.prototype.constructor=i,i.prototype.isType=function(t){return!!t.match(/real([0-9]*)?(\[([0-9]*)\])?/)},e.exports=i},{"./formatters":9,"./type":14}],13:[function(t,e,n){var r=t("./formatters"),o=t("./type"),i=function(){this._inputFormatter=r.formatInputString,this._outputFormatter=r.formatOutputString};i.prototype=new o({}),i.prototype.constructor=i,i.prototype.isType=function(t){return!!t.match(/^string(\[([0-9]*)\])*$/)},i.prototype.isDynamicType=function(){return!0},e.exports=i},{"./formatters":9,"./type":14}],14:[function(t,e,n){var r=t("./formatters"),o=t("./param"),i=function(t){this._inputFormatter=t.inputFormatter,this._outputFormatter=t.outputFormatter};i.prototype.isType=function(t){throw"this method should be overrwritten for type "+t},i.prototype.staticPartLength=function(t){return(this.nestedTypes(t)||["[1]"]).map(function(t){return parseInt(t.slice(1,-1),10)||1}).reduce(function(t,e){return t*e},32)},i.prototype.isDynamicArray=function(t){var e=this.nestedTypes(t);return!!e&&!e[e.length-1].match(/[0-9]{1,}/g)},i.prototype.isStaticArray=function(t){var e=this.nestedTypes(t);return!!e&&!!e[e.length-1].match(/[0-9]{1,}/g)},i.prototype.staticArrayLength=function(t){var e=this.nestedTypes(t);return e?parseInt(e[e.length-1].match(/[0-9]{1,}/g)||1):1},i.prototype.nestedName=function(t){var e=this.nestedTypes(t);return e?t.substr(0,t.length-e[e.length-1].length):t},i.prototype.isDynamicType=function(){return!1},i.prototype.nestedTypes=function(t){return t.match(/(\[[0-9]*\])/g)},i.prototype.encode=function(t,e){var n=this;return this.isDynamicArray(e)?function(){var o=t.length,i=n.nestedName(e),a=[];return a.push(r.formatInputInt(o).encode()),t.forEach(function(t){a.push(n.encode(t,i))}),a}():this.isStaticArray(e)?function(){for(var r=n.staticArrayLength(e),o=n.nestedName(e),i=[],a=0;a<r;a++)i.push(n.encode(t[a],o));return i}():this._inputFormatter(t,e).encode()},i.prototype.decode=function(t,e,n){var r=this;if(this.isDynamicArray(n))return function(){for(var o=parseInt("0x"+t.substr(2*e,64)),i=parseInt("0x"+t.substr(2*o,64)),a=o+32,s=r.nestedName(n),c=r.staticPartLength(s),u=32*Math.floor((c+31)/32),f=[],l=0;l<i*u;l+=u)f.push(r.decode(t,a+l,s));return f}();if(this.isStaticArray(n))return function(){for(var o=r.staticArrayLength(n),i=e,a=r.nestedName(n),s=r.staticPartLength(a),c=32*Math.floor((s+31)/32),u=[],f=0;f<o*c;f+=c)u.push(r.decode(t,i+f,a));return u}();if(this.isDynamicType(n))return function(){var i=parseInt("0x"+t.substr(2*e,64)),a=parseInt("0x"+t.substr(2*i,64)),s=Math.floor((a+31)/32),c=new o(t.substr(2*i,64*(1+s)),0);return r._outputFormatter(c,n)}();var i=this.staticPartLength(n),a=new o(t.substr(2*e,2*i));return this._outputFormatter(a,n)},e.exports=i},{"./formatters":9,"./param":11}],15:[function(t,e,n){var r=t("./formatters"),o=t("./type"),i=function(){this._inputFormatter=r.formatInputInt,this._outputFormatter=r.formatOutputUInt};i.prototype=new o({}),i.prototype.constructor=i,i.prototype.isType=function(t){return!!t.match(/^uint([0-9]*)?(\[([0-9]*)\])*$/)},e.exports=i},{"./formatters":9,"./type":14}],16:[function(t,e,n){var r=t("./formatters"),o=t("./type"),i=function(){this._inputFormatter=r.formatInputReal,this._outputFormatter=r.formatOutputUReal};i.prototype=new o({}),i.prototype.constructor=i,i.prototype.isType=function(t){return!!t.match(/^ureal([0-9]*)?(\[([0-9]*)\])*$/)},e.exports=i},{"./formatters":9,"./type":14}],17:[function(t,e,n){"use strict";"undefined"==typeof XMLHttpRequest?n.XMLHttpRequest={}:n.XMLHttpRequest=XMLHttpRequest},{}],18:[function(t,e,n){var r=t("bignumber.js"),o=["wei","kwei","Mwei","Gwei","szabo","finney","femtoether","picoether","nanoether","microether","milliether","nano","micro","milli","ether","grand","Mether","Gether","Tether","Pether","Eether","Zether","Yether","Nether","Dether","Vether","Uether"];e.exports={ETH_PADDING:32,ETH_SIGNATURE_LENGTH:4,ETH_UNITS:o,ETH_BIGNUMBER_ROUNDING_MODE:{ROUNDING_MODE:r.ROUND_DOWN},ETH_POLLING_TIMEOUT:500,defaultBlock:"latest",defaultAccount:void 0}},{"bignumber.js":"bignumber.js"}],19:[function(t,e,n){var r=t("crypto-js"),o=t("crypto-js/sha3");e.exports=function(t,e){return e&&"hex"===e.encoding&&(t.length>2&&"0x"===t.substr(0,2)&&(t=t.substr(2)),t=r.enc.Hex.parse(t)),o(t,{outputLength:256}).toString()}},{"crypto-js":59,"crypto-js/sha3":80}],20:[function(t,e,n){var r=t("bignumber.js"),o=t("./sha3.js"),i=t("utf8"),a={noether:"0",wei:"1",kwei:"1000",Kwei:"1000",babbage:"1000",femtoether:"1000",mwei:"1000000",Mwei:"1000000",lovelace:"1000000",picoether:"1000000",gwei:"1000000000",Gwei:"1000000000",shannon:"1000000000",nanoether:"1000000000",nano:"1000000000",szabo:"1000000000000",microether:"1000000000000",micro:"1000000000000",finney:"1000000000000000",milliether:"1000000000000000",milli:"1000000000000000",ether:"1000000000000000000",kether:"1000000000000000000000",grand:"1000000000000000000000",mether:"1000000000000000000000000",gether:"1000000000000000000000000000",tether:"1000000000000000000000000000000"},s=function(t,e,n){return new Array(e-t.length+1).join(n?n:"0")+t},c=function(t,e,n){return t+new Array(e-t.length+1).join(n?n:"0")},u=function(t){var e="",n=0,r=t.length;for("0x"===t.substring(0,2)&&(n=2);n<r;n+=2){var o=parseInt(t.substr(n,2),16);if(0===o)break;e+=String.fromCharCode(o)}return i.decode(e)},f=function(t){var e="",n=0,r=t.length;for("0x"===t.substring(0,2)&&(n=2);n<r;n+=2){var o=parseInt(t.substr(n,2),16);e+=String.fromCharCode(o)}return e},l=function(t){t=i.encode(t);for(var e="",n=0;n<t.length;n++){var r=t.charCodeAt(n);if(0===r)break;var o=r.toString(16);e+=o.length<2?"0"+o:o}return"0x"+e},p=function(t){for(var e="",n=0;n<t.length;n++){var r=t.charCodeAt(n),o=r.toString(16);e+=o.length<2?"0"+o:o}return"0x"+e},h=function(t){if(t.name.indexOf("(")!==-1)return t.name;var e=t.inputs.map(function(t){return t.type}).join();return t.name+"("+e+")"},d=function(t){var e=t.indexOf("(");return e!==-1?t.substr(0,e):t},m=function(t){var e=t.indexOf("(");return e!==-1?t.substr(e+1,t.length-1-(e+1)).replace(" ",""):""},y=function(t){return x(t).toNumber()},g=function(t){var e=x(t),n=e.toString(16);return e.lessThan(0)?"-0x"+n.substr(1):"0x"+n},v=function(t){if(D(t))return g(+t);if(I(t))return g(t);if(T(t))return l(JSON.stringify(t));if(O(t)){if(0===t.indexOf("-0x"))return g(t);if(0===t.indexOf("0x"))return t;if(!isFinite(t))return p(t)}return g(t)},b=function(t){t=t?t.toLowerCase():"ether";var e=a[t];if(void 0===e)throw new Error("This unit doesn't exists, please use the one of the following units"+JSON.stringify(a,null,2));return new r(e,10)},_=function(t,e){var n=x(t).dividedBy(b(e));return I(t)?n:n.toString(10)},w=function(t,e){var n=x(t).times(b(e));return I(t)?n:n.toString(10)},x=function(t){return t=t||0,I(t)?t:!O(t)||0!==t.indexOf("0x")&&0!==t.indexOf("-0x")?new r(t.toString(10),10):new r(t.replace("0x",""),16)},k=function(t){var e=x(t).round();return e.lessThan(0)?new r("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",16).plus(e).plus(1):e},B=function(t){return/^0x[0-9a-f]{40}$/i.test(t)},S=function(t){return!!/^(0x)?[0-9a-f]{40}$/i.test(t)&&(!(!/^(0x)?[0-9a-f]{40}$/.test(t)&&!/^(0x)?[0-9A-F]{40}$/.test(t))||C(t))},C=function(t){t=t.replace("0x","");for(var e=o(t.toLowerCase()),n=0;n<40;n++)if(parseInt(e[n],16)>7&&t[n].toUpperCase()!==t[n]||parseInt(e[n],16)<=7&&t[n].toLowerCase()!==t[n])return!1;return!0},A=function(t){if("undefined"==typeof t)return"";t=t.toLowerCase().replace("0x","");for(var e=o(t),n="0x",r=0;r<t.length;r++)n+=parseInt(e[r],16)>7?t[r].toUpperCase():t[r];return n},F=function(t){return B(t)?t:/^[0-9a-f]{40}$/.test(t)?"0x"+t:"0x"+s(v(t).substr(2),40)},I=function(t){return t instanceof r||t&&t.constructor&&"BigNumber"===t.constructor.name},O=function(t){return"string"==typeof t||t&&t.constructor&&"String"===t.constructor.name},N=function(t){return"function"==typeof t},T=function(t){return"object"==typeof t},D=function(t){return"boolean"==typeof t},E=function(t){return t instanceof Array},P=function(t){try{return!!JSON.parse(t)}catch(t){return!1}};e.exports={padLeft:s,padRight:c,toHex:v,toDecimal:y,fromDecimal:g,toUtf8:u,toAscii:f,fromUtf8:l,fromAscii:p,transformToFullName:h,extractDisplayName:d,extractTypeName:m,toWei:w,fromWei:_,toBigNumber:x,toTwosComplement:k,toAddress:F,isBigNumber:I,isStrictAddress:B,isAddress:S,isChecksumAddress:C,toChecksumAddress:A,isFunction:N,isString:O,isObject:T,isBoolean:D,isArray:E,isJson:P}},{"./sha3.js":19,"bignumber.js":"bignumber.js",utf8:85}],21:[function(t,e,n){e.exports={version:"0.18.2"}},{}],22:[function(t,e,n){function r(t){this._requestManager=new o(t),this.currentProvider=t,this.eth=new a(this),this.db=new s(this),this.shh=new c(this),this.net=new u(this),this.personal=new f(this),this.bzz=new l(this),this.settings=new p,this.version={api:h.version},this.providers={HttpProvider:b,IpcProvider:_},this._extend=y(this),this._extend({properties:x()})}var o=t("./web3/requestmanager"),i=t("./web3/iban"),a=t("./web3/methods/eth"),s=t("./web3/methods/db"),c=t("./web3/methods/shh"),u=t("./web3/methods/net"),f=t("./web3/methods/personal"),l=t("./web3/methods/swarm"),p=t("./web3/settings"),h=t("./version.json"),d=t("./utils/utils"),m=t("./utils/sha3"),y=t("./web3/extend"),g=t("./web3/batch"),v=t("./web3/property"),b=t("./web3/httpprovider"),_=t("./web3/ipcprovider"),w=t("bignumber.js");r.providers={HttpProvider:b,IpcProvider:_},r.prototype.setProvider=function(t){this._requestManager.setProvider(t),this.currentProvider=t},r.prototype.reset=function(t){this._requestManager.reset(t),this.settings=new p},r.prototype.BigNumber=w,r.prototype.toHex=d.toHex,r.prototype.toAscii=d.toAscii,r.prototype.toUtf8=d.toUtf8,r.prototype.fromAscii=d.fromAscii,r.prototype.fromUtf8=d.fromUtf8,r.prototype.toDecimal=d.toDecimal,r.prototype.fromDecimal=d.fromDecimal,r.prototype.toBigNumber=d.toBigNumber,r.prototype.toWei=d.toWei,r.prototype.fromWei=d.fromWei,r.prototype.isAddress=d.isAddress,r.prototype.isChecksumAddress=d.isChecksumAddress,r.prototype.toChecksumAddress=d.toChecksumAddress,r.prototype.isIBAN=d.isIBAN,r.prototype.sha3=function(t,e){return"0x"+m(t,e)},r.prototype.fromICAP=function(t){var e=new i(t);return e.address()};var x=function(){return[new v({name:"version.node",getter:"web3_clientVersion"}),new v({name:"version.network",getter:"net_version",inputFormatter:d.toDecimal}),new v({name:"version.ethereum",getter:"eth_protocolVersion",inputFormatter:d.toDecimal}),new v({name:"version.whisper",getter:"shh_version",inputFormatter:d.toDecimal})]};r.prototype.isConnected=function(){return this.currentProvider&&this.currentProvider.isConnected()},r.prototype.createBatch=function(){return new g(this)},e.exports=r},{"./utils/sha3":19,"./utils/utils":20,"./version.json":21,"./web3/batch":24,"./web3/extend":28,"./web3/httpprovider":32,"./web3/iban":33,"./web3/ipcprovider":34,"./web3/methods/db":37,"./web3/methods/eth":38,"./web3/methods/net":39,"./web3/methods/personal":40,"./web3/methods/shh":41,"./web3/methods/swarm":42,"./web3/property":45,"./web3/requestmanager":46,"./web3/settings":47,"bignumber.js":"bignumber.js"}],23:[function(t,e,n){var r=t("../utils/sha3"),o=t("./event"),i=t("./formatters"),a=t("../utils/utils"),s=t("./filter"),c=t("./methods/watches"),u=function(t,e,n){this._requestManager=t,this._json=e,this._address=n};u.prototype.encode=function(t){t=t||{};var e={};return["fromBlock","toBlock"].filter(function(e){return void 0!==t[e]}).forEach(function(n){e[n]=i.inputBlockNumberFormatter(t[n])}),e.address=this._address,e},u.prototype.decode=function(t){t.data=t.data||"",t.topics=t.topics||[];var e=t.topics[0].slice(2),n=this._json.filter(function(t){return e===r(a.transformToFullName(t))})[0];if(!n)return console.warn("cannot find event for log"),t;var i=new o(this._requestManager,n,this._address);return i.decode(t)},u.prototype.execute=function(t,e){a.isFunction(arguments[arguments.length-1])&&(e=arguments[arguments.length-1],1===arguments.length&&(t=null));var n=this.encode(t),r=this.decode.bind(this);return new s(this._requestManager,n,c.eth(),r,e)},u.prototype.attachToContract=function(t){var e=this.execute.bind(this);t.allEvents=e},e.exports=u},{"../utils/sha3":19,"../utils/utils":20,"./event":27,"./filter":29,"./formatters":30,"./methods/watches":43}],24:[function(t,e,n){var r=t("./jsonrpc"),o=t("./errors"),i=function(t){this.requestManager=t._requestManager,this.requests=[]};i.prototype.add=function(t){this.requests.push(t)},i.prototype.execute=function(){var t=this.requests;this.requestManager.sendBatch(t,function(e,n){n=n||[],t.map(function(t,e){return n[e]||{}}).forEach(function(e,n){if(t[n].callback){if(!r.isValidResponse(e))return t[n].callback(o.InvalidResponse(e));t[n].callback(null,t[n].format?t[n].format(e.result):e.result)}})})},e.exports=i},{"./errors":26,"./jsonrpc":35}],25:[function(t,e,n){var r=t("../utils/utils"),o=t("../solidity/coder"),i=t("./event"),a=t("./function"),s=t("./allevents"),c=function(t,e){return t.filter(function(t){return"constructor"===t.type&&t.inputs.length===e.length}).map(function(t){return t.inputs.map(function(t){return t.type})}).map(function(t){return o.encodeParams(t,e)})[0]||""},u=function(t){t.abi.filter(function(t){return"function"===t.type}).map(function(e){return new a(t._eth,e,t.address)}).forEach(function(e){e.attachToContract(t)})},f=function(t){var e=t.abi.filter(function(t){return"event"===t.type}),n=new s(t._eth._requestManager,e,t.address);n.attachToContract(t),e.map(function(e){return new i(t._eth._requestManager,e,t.address)}).forEach(function(e){e.attachToContract(t)})},l=function(t,e){var n=0,r=!1,o=t._eth.filter("latest",function(i){if(!i&&!r)if(n++,n>50){if(o.stopWatching(function(){}),r=!0,!e)throw new Error("Contract transaction couldn't be found after 50 blocks");e(new Error("Contract transaction couldn't be found after 50 blocks"))}else t._eth.getTransactionReceipt(t.transactionHash,function(n,i){i&&!r&&t._eth.getCode(i.contractAddress,function(n,a){if(!r&&a)if(o.stopWatching(function(){}),r=!0,a.length>3)t.address=i.contractAddress,u(t),f(t),e&&e(null,t);else{if(!e)throw new Error("The contract code couldn't be stored, please check your gas amount.");e(new Error("The contract code couldn't be stored, please check your gas amount."))}})})})},p=function(t,e){this.eth=t,this.abi=e,this.new=function(){var t,n=new h(this.eth,this.abi),o={},i=Array.prototype.slice.call(arguments);r.isFunction(i[i.length-1])&&(t=i.pop());var a=i[i.length-1];if(r.isObject(a)&&!r.isArray(a)&&(o=i.pop()),o.value>0){var s=e.filter(function(t){return"constructor"===t.type&&t.inputs.length===i.length})[0]||{};if(!s.payable)throw new Error("Cannot send value to non-payable constructor")}var u=c(this.abi,i);if(o.data+=u,t)this.eth.sendTransaction(o,function(e,r){e?t(e):(n.transactionHash=r,t(null,n),l(n,t))});else{var f=this.eth.sendTransaction(o);n.transactionHash=f,l(n)}return n},this.new.getData=this.getData.bind(this)};p.prototype.at=function(t,e){var n=new h(this.eth,this.abi,t);return u(n),f(n),e&&e(null,n),n},p.prototype.getData=function(){var t={},e=Array.prototype.slice.call(arguments),n=e[e.length-1];r.isObject(n)&&!r.isArray(n)&&(t=e.pop());var o=c(this.abi,e);return t.data+=o,t.data};var h=function(t,e,n){this._eth=t,this.transactionHash=null,this.address=n,this.abi=e};e.exports=p},{"../solidity/coder":7,"../utils/utils":20,"./allevents":23,"./event":27,"./function":31}],26:[function(t,e,n){e.exports={InvalidNumberOfParams:function(){return new Error("Invalid number of input parameters")},InvalidConnection:function(t){return new Error("CONNECTION ERROR: Couldn't connect to node "+t+".")},InvalidProvider:function(){return new Error("Provider not set or invalid")},InvalidResponse:function(t){var e=t&&t.error&&t.error.message?t.error.message:"Invalid JSON RPC response: "+JSON.stringify(t);return new Error(e)},ConnectionTimeout:function(t){return new Error("CONNECTION TIMEOUT: timeout of "+t+" ms achived")}}},{}],27:[function(t,e,n){var r=t("../utils/utils"),o=t("../solidity/coder"),i=t("./formatters"),a=t("../utils/sha3"),s=t("./filter"),c=t("./methods/watches"),u=function(t,e,n){this._requestManager=t,this._params=e.inputs,this._name=r.transformToFullName(e),this._address=n,this._anonymous=e.anonymous};u.prototype.types=function(t){return this._params.filter(function(e){return e.indexed===t}).map(function(t){return t.type})},u.prototype.displayName=function(){return r.extractDisplayName(this._name)},u.prototype.typeName=function(){return r.extractTypeName(this._name)},u.prototype.signature=function(){return a(this._name)},u.prototype.encode=function(t,e){t=t||{},e=e||{};var n={};["fromBlock","toBlock"].filter(function(t){return void 0!==e[t]}).forEach(function(t){n[t]=i.inputBlockNumberFormatter(e[t])}),n.topics=[],n.address=this._address,this._anonymous||n.topics.push("0x"+this.signature());var a=this._params.filter(function(t){return t.indexed===!0}).map(function(e){var n=t[e.name];return void 0===n||null===n?null:r.isArray(n)?n.map(function(t){return"0x"+o.encodeParam(e.type,t)}):"0x"+o.encodeParam(e.type,n)});return n.topics=n.topics.concat(a),n},u.prototype.decode=function(t){t.data=t.data||"",t.topics=t.topics||[];var e=this._anonymous?t.topics:t.topics.slice(1),n=e.map(function(t){return t.slice(2)}).join(""),r=o.decodeParams(this.types(!0),n),a=t.data.slice(2),s=o.decodeParams(this.types(!1),a),c=i.outputLogFormatter(t);return c.event=this.displayName(),c.address=t.address,c.args=this._params.reduce(function(t,e){return t[e.name]=e.indexed?r.shift():s.shift(),t},{}),delete c.data,delete c.topics,c},u.prototype.execute=function(t,e,n){r.isFunction(arguments[arguments.length-1])&&(n=arguments[arguments.length-1],2===arguments.length&&(e=null),1===arguments.length&&(e=null,t={}));var o=this.encode(t,e),i=this.decode.bind(this);return new s(this._requestManager,o,c.eth(),i,n)},u.prototype.attachToContract=function(t){var e=this.execute.bind(this),n=this.displayName();t[n]||(t[n]=e),t[n][this.typeName()]=this.execute.bind(this,t)},e.exports=u},{"../solidity/coder":7,"../utils/sha3":19,"../utils/utils":20,"./filter":29,"./formatters":30,"./methods/watches":43}],28:[function(t,e,n){var r=t("./formatters"),o=t("./../utils/utils"),i=t("./method"),a=t("./property"),s=function(t){var e=function(e){var n;e.property?(t[e.property]||(t[e.property]={}),n=t[e.property]):n=t,e.methods&&e.methods.forEach(function(e){e.attachToObject(n),e.setRequestManager(t._requestManager)}),e.properties&&e.properties.forEach(function(e){e.attachToObject(n),e.setRequestManager(t._requestManager)})};return e.formatters=r,e.utils=o,e.Method=i,e.Property=a,e};e.exports=s},{"./../utils/utils":20,"./formatters":30,"./method":36,"./property":45}],29:[function(t,e,n){var r=t("./formatters"),o=t("../utils/utils"),i=function(t){return null===t||"undefined"==typeof t?null:(t=String(t),0===t.indexOf("0x")?t:o.fromUtf8(t))},a=function(t){return o.isString(t)?t:(t=t||{},t.topics=t.topics||[],t.topics=t.topics.map(function(t){return o.isArray(t)?t.map(i):i(t)}),{topics:t.topics,from:t.from,to:t.to,address:t.address,fromBlock:r.inputBlockNumberFormatter(t.fromBlock),toBlock:r.inputBlockNumberFormatter(t.toBlock)})},s=function(t,e){o.isString(t.options)||t.get(function(t,n){t&&e(t),o.isArray(n)&&n.forEach(function(t){e(null,t)})})},c=function(t){var e=function(e,n){return e?t.callbacks.forEach(function(t){t(e)}):void(o.isArray(n)&&n.forEach(function(e){e=t.formatter?t.formatter(e):e,t.callbacks.forEach(function(t){t(null,e)})}))};t.requestManager.startPolling({method:t.implementation.poll.call,params:[t.filterId]},t.filterId,e,t.stopWatching.bind(t))},u=function(t,e,n,r,o,i){var u=this,f={};return n.forEach(function(e){e.setRequestManager(t),e.attachToObject(f)}),this.requestManager=t,this.options=a(e),this.implementation=f,this.filterId=null,this.callbacks=[],this.getLogsCallbacks=[],this.pollFilters=[],this.formatter=r,this.implementation.newFilter(this.options,function(t,e){
if(t)u.callbacks.forEach(function(e){e(t)}),i(t);else if(u.filterId=e,u.getLogsCallbacks.forEach(function(t){u.get(t)}),u.getLogsCallbacks=[],u.callbacks.forEach(function(t){s(u,t)}),u.callbacks.length>0&&c(u),"function"==typeof o)return u.watch(o)}),this};u.prototype.watch=function(t){return this.callbacks.push(t),this.filterId&&(s(this,t),c(this)),this},u.prototype.stopWatching=function(t){return this.requestManager.stopPolling(this.filterId),this.callbacks=[],t?void this.implementation.uninstallFilter(this.filterId,t):this.implementation.uninstallFilter(this.filterId)},u.prototype.get=function(t){var e=this;if(!o.isFunction(t)){if(null===this.filterId)throw new Error("Filter ID Error: filter().get() can't be chained synchronous, please provide a callback for the get() method.");var n=this.implementation.getLogs(this.filterId);return n.map(function(t){return e.formatter?e.formatter(t):t})}return null===this.filterId?this.getLogsCallbacks.push(t):this.implementation.getLogs(this.filterId,function(n,r){n?t(n):t(null,r.map(function(t){return e.formatter?e.formatter(t):t}))}),this},e.exports=u},{"../utils/utils":20,"./formatters":30}],30:[function(t,e,n){var r=t("../utils/utils"),o=t("../utils/config"),i=t("./iban"),a=function(t){return r.toBigNumber(t)},s=function(t){return"latest"===t||"pending"===t||"earliest"===t},c=function(t){return void 0===t?o.defaultBlock:u(t)},u=function(t){if(void 0!==t)return s(t)?t:r.toHex(t)},f=function(t){return t.from=t.from||o.defaultAccount,t.from&&(t.from=v(t.from)),t.to&&(t.to=v(t.to)),["gasPrice","gas","value","nonce"].filter(function(e){return void 0!==t[e]}).forEach(function(e){t[e]=r.fromDecimal(t[e])}),t},l=function(t){return t.from=t.from||o.defaultAccount,t.from=v(t.from),t.to&&(t.to=v(t.to)),["gasPrice","gas","value","nonce"].filter(function(e){return void 0!==t[e]}).forEach(function(e){t[e]=r.fromDecimal(t[e])}),t},p=function(t){return null!==t.blockNumber&&(t.blockNumber=r.toDecimal(t.blockNumber)),null!==t.transactionIndex&&(t.transactionIndex=r.toDecimal(t.transactionIndex)),t.nonce=r.toDecimal(t.nonce),t.gas=r.toDecimal(t.gas),t.gasPrice=r.toBigNumber(t.gasPrice),t.value=r.toBigNumber(t.value),t},h=function(t){return null!==t.blockNumber&&(t.blockNumber=r.toDecimal(t.blockNumber)),null!==t.transactionIndex&&(t.transactionIndex=r.toDecimal(t.transactionIndex)),t.cumulativeGasUsed=r.toDecimal(t.cumulativeGasUsed),t.gasUsed=r.toDecimal(t.gasUsed),r.isArray(t.logs)&&(t.logs=t.logs.map(function(t){return m(t)})),t},d=function(t){return t.gasLimit=r.toDecimal(t.gasLimit),t.gasUsed=r.toDecimal(t.gasUsed),t.size=r.toDecimal(t.size),t.timestamp=r.toDecimal(t.timestamp),null!==t.number&&(t.number=r.toDecimal(t.number)),t.difficulty=r.toBigNumber(t.difficulty),t.totalDifficulty=r.toBigNumber(t.totalDifficulty),r.isArray(t.transactions)&&t.transactions.forEach(function(t){if(!r.isString(t))return p(t)}),t},m=function(t){return null!==t.blockNumber&&(t.blockNumber=r.toDecimal(t.blockNumber)),null!==t.transactionIndex&&(t.transactionIndex=r.toDecimal(t.transactionIndex)),null!==t.logIndex&&(t.logIndex=r.toDecimal(t.logIndex)),t},y=function(t){return t.ttl=r.fromDecimal(t.ttl),t.workToProve=r.fromDecimal(t.workToProve),t.priority=r.fromDecimal(t.priority),r.isArray(t.topics)||(t.topics=t.topics?[t.topics]:[]),t.topics=t.topics.map(function(t){return 0===t.indexOf("0x")?t:r.fromUtf8(t)}),t},g=function(t){return t.expiry=r.toDecimal(t.expiry),t.sent=r.toDecimal(t.sent),t.ttl=r.toDecimal(t.ttl),t.workProved=r.toDecimal(t.workProved),t.topics||(t.topics=[]),t.topics=t.topics.map(function(t){return r.toAscii(t)}),t},v=function(t){var e=new i(t);if(e.isValid()&&e.isDirect())return"0x"+e.address();if(r.isStrictAddress(t))return t;if(r.isAddress(t))return"0x"+t;throw new Error("invalid address")},b=function(t){return t.startingBlock=r.toDecimal(t.startingBlock),t.currentBlock=r.toDecimal(t.currentBlock),t.highestBlock=r.toDecimal(t.highestBlock),t.knownStates&&(t.knownStates=r.toDecimal(t.knownStates),t.pulledStates=r.toDecimal(t.pulledStates)),t};e.exports={inputDefaultBlockNumberFormatter:c,inputBlockNumberFormatter:u,inputCallFormatter:f,inputTransactionFormatter:l,inputAddressFormatter:v,inputPostFormatter:y,outputBigNumberFormatter:a,outputTransactionFormatter:p,outputTransactionReceiptFormatter:h,outputBlockFormatter:d,outputLogFormatter:m,outputPostFormatter:g,outputSyncingFormatter:b}},{"../utils/config":18,"../utils/utils":20,"./iban":33}],31:[function(t,e,n){var r=t("../solidity/coder"),o=t("../utils/utils"),i=t("./formatters"),a=t("../utils/sha3"),s=function(t,e,n){this._eth=t,this._inputTypes=e.inputs.map(function(t){return t.type}),this._outputTypes=e.outputs.map(function(t){return t.type}),this._constant=e.constant,this._payable=e.payable,this._name=o.transformToFullName(e),this._address=n};s.prototype.extractCallback=function(t){if(o.isFunction(t[t.length-1]))return t.pop()},s.prototype.extractDefaultBlock=function(t){if(t.length>this._inputTypes.length&&!o.isObject(t[t.length-1]))return i.inputDefaultBlockNumberFormatter(t.pop())},s.prototype.toPayload=function(t){var e={};return t.length>this._inputTypes.length&&o.isObject(t[t.length-1])&&(e=t[t.length-1]),e.to=this._address,e.data="0x"+this.signature()+r.encodeParams(this._inputTypes,t),e},s.prototype.signature=function(){return a(this._name).slice(0,8)},s.prototype.unpackOutput=function(t){if(t){t=t.length>=2?t.slice(2):t;var e=r.decodeParams(this._outputTypes,t);return 1===e.length?e[0]:e}},s.prototype.call=function(){var t=Array.prototype.slice.call(arguments).filter(function(t){return void 0!==t}),e=this.extractCallback(t),n=this.extractDefaultBlock(t),r=this.toPayload(t);if(!e){var o=this._eth.call(r,n);return this.unpackOutput(o)}var i=this;this._eth.call(r,n,function(t,n){if(t)return e(t,null);var r=null;try{r=i.unpackOutput(n)}catch(e){t=e}e(t,r)})},s.prototype.sendTransaction=function(){var t=Array.prototype.slice.call(arguments).filter(function(t){return void 0!==t}),e=this.extractCallback(t),n=this.toPayload(t);if(n.value>0&&!this._payable)throw new Error("Cannot send value to non-payable function");return e?void this._eth.sendTransaction(n,e):this._eth.sendTransaction(n)},s.prototype.estimateGas=function(){var t=Array.prototype.slice.call(arguments),e=this.extractCallback(t),n=this.toPayload(t);return e?void this._eth.estimateGas(n,e):this._eth.estimateGas(n)},s.prototype.getData=function(){var t=Array.prototype.slice.call(arguments),e=this.toPayload(t);return e.data},s.prototype.displayName=function(){return o.extractDisplayName(this._name)},s.prototype.typeName=function(){return o.extractTypeName(this._name)},s.prototype.request=function(){var t=Array.prototype.slice.call(arguments),e=this.extractCallback(t),n=this.toPayload(t),r=this.unpackOutput.bind(this);return{method:this._constant?"eth_call":"eth_sendTransaction",callback:e,params:[n],format:r}},s.prototype.execute=function(){var t=!this._constant;return t?this.sendTransaction.apply(this,Array.prototype.slice.call(arguments)):this.call.apply(this,Array.prototype.slice.call(arguments))},s.prototype.attachToContract=function(t){var e=this.execute.bind(this);e.request=this.request.bind(this),e.call=this.call.bind(this),e.sendTransaction=this.sendTransaction.bind(this),e.estimateGas=this.estimateGas.bind(this),e.getData=this.getData.bind(this);var n=this.displayName();t[n]||(t[n]=e),t[n][this.typeName()]=e},e.exports=s},{"../solidity/coder":7,"../utils/sha3":19,"../utils/utils":20,"./formatters":30}],32:[function(t,e,n){var r=t("./errors");"undefined"!=typeof window&&window.XMLHttpRequest?XMLHttpRequest=window.XMLHttpRequest:XMLHttpRequest=t("xmlhttprequest").XMLHttpRequest;var o=t("xhr2"),i=function(t,e){this.host=t||"http://localhost:8545",this.timeout=e||0};i.prototype.prepareRequest=function(t){var e;return t?(e=new o,e.timeout=this.timeout):e=new XMLHttpRequest,e.open("POST",this.host,t),e.setRequestHeader("Content-Type","application/json"),e},i.prototype.send=function(t){var e=this.prepareRequest(!1);try{e.send(JSON.stringify(t))}catch(t){throw r.InvalidConnection(this.host)}var n=e.responseText;try{n=JSON.parse(n)}catch(t){throw r.InvalidResponse(e.responseText)}return n},i.prototype.sendAsync=function(t,e){var n=this.prepareRequest(!0);n.onreadystatechange=function(){if(4===n.readyState&&1!==n.timeout){var t=n.responseText,o=null;try{t=JSON.parse(t)}catch(t){o=r.InvalidResponse(n.responseText)}e(o,t)}},n.ontimeout=function(){e(r.ConnectionTimeout(this.timeout))};try{n.send(JSON.stringify(t))}catch(t){e(r.InvalidConnection(this.host))}},i.prototype.isConnected=function(){try{return this.send({id:9999999999,jsonrpc:"2.0",method:"net_listening",params:[]}),!0}catch(t){return!1}},e.exports=i},{"./errors":26,xhr2:86,xmlhttprequest:17}],33:[function(t,e,n){var r=t("bignumber.js"),o=function(t,e){for(var n=t;n.length<2*e;)n="0"+n;return n},i=function(t){var e="A".charCodeAt(0),n="Z".charCodeAt(0);return t=t.toUpperCase(),t=t.substr(4)+t.substr(0,4),t.split("").map(function(t){var r=t.charCodeAt(0);return r>=e&&r<=n?r-e+10:t}).join("")},a=function(t){for(var e,n=t;n.length>2;)e=n.slice(0,9),n=parseInt(e,10)%97+n.slice(e.length);return parseInt(n,10)%97},s=function(t){this._iban=t};s.fromAddress=function(t){var e=new r(t,16),n=e.toString(36),i=o(n,15);return s.fromBban(i.toUpperCase())},s.fromBban=function(t){var e="XE",n=a(i(e+"00"+t)),r=("0"+(98-n)).slice(-2);return new s(e+r+t)},s.createIndirect=function(t){return s.fromBban("ETH"+t.institution+t.identifier)},s.isValid=function(t){var e=new s(t);return e.isValid()},s.prototype.isValid=function(){return/^XE[0-9]{2}(ETH[0-9A-Z]{13}|[0-9A-Z]{30,31})$/.test(this._iban)&&1===a(i(this._iban))},s.prototype.isDirect=function(){return 34===this._iban.length||35===this._iban.length},s.prototype.isIndirect=function(){return 20===this._iban.length},s.prototype.checksum=function(){return this._iban.substr(2,2)},s.prototype.institution=function(){return this.isIndirect()?this._iban.substr(7,4):""},s.prototype.client=function(){return this.isIndirect()?this._iban.substr(11):""},s.prototype.address=function(){if(this.isDirect()){var t=this._iban.substr(4),e=new r(t,36);return o(e.toString(16),20)}return""},s.prototype.toString=function(){return this._iban},e.exports=s},{"bignumber.js":"bignumber.js"}],34:[function(t,e,n){"use strict";var r=t("../utils/utils"),o=t("./errors"),i=function(t,e){var n=this;this.responseCallbacks={},this.path=t,this.connection=e.connect({path:this.path}),this.connection.on("error",function(t){console.error("IPC Connection Error",t),n._timeout()}),this.connection.on("end",function(){n._timeout()}),this.connection.on("data",function(t){n._parseResponse(t.toString()).forEach(function(t){var e=null;r.isArray(t)?t.forEach(function(t){n.responseCallbacks[t.id]&&(e=t.id)}):e=t.id,n.responseCallbacks[e]&&(n.responseCallbacks[e](null,t),delete n.responseCallbacks[e])})})};i.prototype._parseResponse=function(t){var e=this,n=[],r=t.replace(/\}[\n\r]?\{/g,"}|--|{").replace(/\}\][\n\r]?\[\{/g,"}]|--|[{").replace(/\}[\n\r]?\[\{/g,"}|--|[{").replace(/\}\][\n\r]?\{/g,"}]|--|{").split("|--|");return r.forEach(function(t){e.lastChunk&&(t=e.lastChunk+t);var r=null;try{r=JSON.parse(t)}catch(n){return e.lastChunk=t,clearTimeout(e.lastChunkTimeout),void(e.lastChunkTimeout=setTimeout(function(){throw e._timeout(),o.InvalidResponse(t)},15e3))}clearTimeout(e.lastChunkTimeout),e.lastChunk=null,r&&n.push(r)}),n},i.prototype._addResponseCallback=function(t,e){var n=t.id||t[0].id,r=t.method||t[0].method;this.responseCallbacks[n]=e,this.responseCallbacks[n].method=r},i.prototype._timeout=function(){for(var t in this.responseCallbacks)this.responseCallbacks.hasOwnProperty(t)&&(this.responseCallbacks[t](o.InvalidConnection("on IPC")),delete this.responseCallbacks[t])},i.prototype.isConnected=function(){var t=this;return t.connection.writable||t.connection.connect({path:t.path}),!!this.connection.writable},i.prototype.send=function(t){if(this.connection.writeSync){var e;this.connection.writable||this.connection.connect({path:this.path});var n=this.connection.writeSync(JSON.stringify(t));try{e=JSON.parse(n)}catch(t){throw o.InvalidResponse(n)}return e}throw new Error('You tried to send "'+t.method+'" synchronously. Synchronous requests are not supported by the IPC provider.')},i.prototype.sendAsync=function(t,e){this.connection.writable||this.connection.connect({path:this.path}),this.connection.write(JSON.stringify(t)),this._addResponseCallback(t,e)},e.exports=i},{"../utils/utils":20,"./errors":26}],35:[function(t,e,n){var r={messageId:0};r.toPayload=function(t,e){return t||console.error("jsonrpc method should be specified!"),r.messageId++,{jsonrpc:"2.0",id:r.messageId,method:t,params:e||[]}},r.isValidResponse=function(t){function e(t){return!!t&&!t.error&&"2.0"===t.jsonrpc&&"number"==typeof t.id&&void 0!==t.result}return Array.isArray(t)?t.every(e):e(t)},r.toBatchPayload=function(t){return t.map(function(t){return r.toPayload(t.method,t.params)})},e.exports=r},{}],36:[function(t,e,n){var r=t("../utils/utils"),o=t("./errors"),i=function(t){this.name=t.name,this.call=t.call,this.params=t.params||0,this.inputFormatter=t.inputFormatter,this.outputFormatter=t.outputFormatter,this.requestManager=null};i.prototype.setRequestManager=function(t){this.requestManager=t},i.prototype.getCall=function(t){return r.isFunction(this.call)?this.call(t):this.call},i.prototype.extractCallback=function(t){if(r.isFunction(t[t.length-1]))return t.pop()},i.prototype.validateArgs=function(t){if(t.length!==this.params)throw o.InvalidNumberOfParams()},i.prototype.formatInput=function(t){return this.inputFormatter?this.inputFormatter.map(function(e,n){return e?e(t[n]):t[n]}):t},i.prototype.formatOutput=function(t){return this.outputFormatter&&t?this.outputFormatter(t):t},i.prototype.toPayload=function(t){var e=this.getCall(t),n=this.extractCallback(t),r=this.formatInput(t);return this.validateArgs(r),{method:e,params:r,callback:n}},i.prototype.attachToObject=function(t){var e=this.buildCall();e.call=this.call;var n=this.name.split(".");n.length>1?(t[n[0]]=t[n[0]]||{},t[n[0]][n[1]]=e):t[n[0]]=e},i.prototype.buildCall=function(){var t=this,e=function(){var e=t.toPayload(Array.prototype.slice.call(arguments));return e.callback?t.requestManager.sendAsync(e,function(n,r){e.callback(n,t.formatOutput(r))}):t.formatOutput(t.requestManager.send(e))};return e.request=this.request.bind(this),e},i.prototype.request=function(){var t=this.toPayload(Array.prototype.slice.call(arguments));return t.format=this.formatOutput.bind(this),t},e.exports=i},{"../utils/utils":20,"./errors":26}],37:[function(t,e,n){var r=t("../method"),o=function(t){this._requestManager=t._requestManager;var e=this;i().forEach(function(n){n.attachToObject(e),n.setRequestManager(t._requestManager)})},i=function(){var t=new r({name:"putString",call:"db_putString",params:3}),e=new r({name:"getString",call:"db_getString",params:2}),n=new r({name:"putHex",call:"db_putHex",params:3}),o=new r({name:"getHex",call:"db_getHex",params:2});return[t,e,n,o]};e.exports=o},{"../method":36}],38:[function(t,e,n){"use strict";function r(t){this._requestManager=t._requestManager;var e=this;w().forEach(function(t){t.attachToObject(e),t.setRequestManager(e._requestManager)}),x().forEach(function(t){t.attachToObject(e),t.setRequestManager(e._requestManager)}),this.iban=d,this.sendIBANTransaction=m.bind(null,this)}var o=t("../formatters"),i=t("../../utils/utils"),a=t("../method"),s=t("../property"),c=t("../../utils/config"),u=t("../contract"),f=t("./watches"),l=t("../filter"),p=t("../syncing"),h=t("../namereg"),d=t("../iban"),m=t("../transfer"),y=function(t){return i.isString(t[0])&&0===t[0].indexOf("0x")?"eth_getBlockByHash":"eth_getBlockByNumber"},g=function(t){return i.isString(t[0])&&0===t[0].indexOf("0x")?"eth_getTransactionByBlockHashAndIndex":"eth_getTransactionByBlockNumberAndIndex"},v=function(t){return i.isString(t[0])&&0===t[0].indexOf("0x")?"eth_getUncleByBlockHashAndIndex":"eth_getUncleByBlockNumberAndIndex"},b=function(t){return i.isString(t[0])&&0===t[0].indexOf("0x")?"eth_getBlockTransactionCountByHash":"eth_getBlockTransactionCountByNumber"},_=function(t){return i.isString(t[0])&&0===t[0].indexOf("0x")?"eth_getUncleCountByBlockHash":"eth_getUncleCountByBlockNumber"};Object.defineProperty(r.prototype,"defaultBlock",{get:function(){return c.defaultBlock},set:function(t){return c.defaultBlock=t,t}}),Object.defineProperty(r.prototype,"defaultAccount",{get:function(){return c.defaultAccount},set:function(t){return c.defaultAccount=t,t}});var w=function(){var t=new a({name:"getBalance",call:"eth_getBalance",params:2,inputFormatter:[o.inputAddressFormatter,o.inputDefaultBlockNumberFormatter],outputFormatter:o.outputBigNumberFormatter}),e=new a({name:"getStorageAt",call:"eth_getStorageAt",params:3,inputFormatter:[null,i.toHex,o.inputDefaultBlockNumberFormatter]}),n=new a({name:"getCode",call:"eth_getCode",params:2,inputFormatter:[o.inputAddressFormatter,o.inputDefaultBlockNumberFormatter]}),r=new a({name:"getBlock",call:y,params:2,inputFormatter:[o.inputBlockNumberFormatter,function(t){return!!t}],outputFormatter:o.outputBlockFormatter}),s=new a({name:"getUncle",call:v,params:2,inputFormatter:[o.inputBlockNumberFormatter,i.toHex],outputFormatter:o.outputBlockFormatter}),c=new a({name:"getCompilers",call:"eth_getCompilers",params:0}),u=new a({name:"getBlockTransactionCount",call:b,params:1,inputFormatter:[o.inputBlockNumberFormatter],outputFormatter:i.toDecimal}),f=new a({name:"getBlockUncleCount",call:_,params:1,inputFormatter:[o.inputBlockNumberFormatter],outputFormatter:i.toDecimal}),l=new a({name:"getTransaction",call:"eth_getTransactionByHash",params:1,outputFormatter:o.outputTransactionFormatter}),p=new a({name:"getTransactionFromBlock",call:g,params:2,inputFormatter:[o.inputBlockNumberFormatter,i.toHex],outputFormatter:o.outputTransactionFormatter}),h=new a({name:"getTransactionReceipt",call:"eth_getTransactionReceipt",params:1,outputFormatter:o.outputTransactionReceiptFormatter}),d=new a({name:"getTransactionCount",call:"eth_getTransactionCount",params:2,inputFormatter:[null,o.inputDefaultBlockNumberFormatter],outputFormatter:i.toDecimal}),m=new a({name:"sendRawTransaction",call:"eth_sendRawTransaction",params:1,inputFormatter:[null]}),w=new a({name:"sendTransaction",call:"eth_sendTransaction",params:1,inputFormatter:[o.inputTransactionFormatter]}),x=new a({name:"sign",call:"eth_sign",params:2,inputFormatter:[o.inputAddressFormatter,null]}),k=new a({name:"call",call:"eth_call",params:2,inputFormatter:[o.inputCallFormatter,o.inputDefaultBlockNumberFormatter]}),B=new a({name:"estimateGas",call:"eth_estimateGas",params:1,inputFormatter:[o.inputCallFormatter],outputFormatter:i.toDecimal}),S=new a({name:"compile.solidity",call:"eth_compileSolidity",params:1}),C=new a({name:"compile.lll",call:"eth_compileLLL",params:1}),A=new a({name:"compile.serpent",call:"eth_compileSerpent",params:1}),F=new a({name:"submitWork",call:"eth_submitWork",params:3}),I=new a({name:"getWork",call:"eth_getWork",params:0});return[t,e,n,r,s,c,u,f,l,p,h,d,k,B,m,w,x,S,C,A,F,I]},x=function(){return[new s({name:"coinbase",getter:"eth_coinbase"}),new s({name:"mining",getter:"eth_mining"}),new s({name:"hashrate",getter:"eth_hashrate",outputFormatter:i.toDecimal}),new s({name:"syncing",getter:"eth_syncing",outputFormatter:o.outputSyncingFormatter}),new s({name:"gasPrice",getter:"eth_gasPrice",outputFormatter:o.outputBigNumberFormatter}),new s({name:"accounts",getter:"eth_accounts"}),new s({name:"blockNumber",getter:"eth_blockNumber",outputFormatter:i.toDecimal}),new s({name:"protocolVersion",getter:"eth_protocolVersion"})]};r.prototype.contract=function(t){var e=new u(this,t);return e},r.prototype.filter=function(t,e){return new l(this._requestManager,t,f.eth(),o.outputLogFormatter,e)},r.prototype.namereg=function(){return this.contract(h.global.abi).at(h.global.address)},r.prototype.icapNamereg=function(){return this.contract(h.icap.abi).at(h.icap.address)},r.prototype.isSyncing=function(t){return new p(this._requestManager,t)},e.exports=r},{"../../utils/config":18,"../../utils/utils":20,"../contract":25,"../filter":29,"../formatters":30,"../iban":33,"../method":36,"../namereg":44,"../property":45,"../syncing":48,"../transfer":49,"./watches":43}],39:[function(t,e,n){var r=t("../../utils/utils"),o=t("../property"),i=function(t){this._requestManager=t._requestManager;var e=this;a().forEach(function(n){n.attachToObject(e),n.setRequestManager(t._requestManager)})},a=function(){return[new o({name:"listening",getter:"net_listening"}),new o({name:"peerCount",getter:"net_peerCount",outputFormatter:r.toDecimal})]};e.exports=i},{"../../utils/utils":20,"../property":45}],40:[function(t,e,n){"use strict";function r(t){this._requestManager=t._requestManager;var e=this;s().forEach(function(t){t.attachToObject(e),t.setRequestManager(e._requestManager)}),c().forEach(function(t){t.attachToObject(e),t.setRequestManager(e._requestManager)})}var o=t("../method"),i=t("../property"),a=t("../formatters"),s=function(){var t=new o({name:"newAccount",call:"personal_newAccount",params:1,inputFormatter:[null]}),e=new o({name:"unlockAccount",call:"personal_unlockAccount",params:3,inputFormatter:[a.inputAddressFormatter,null,null]}),n=new o({name:"sendTransaction",call:"personal_sendTransaction",params:2,inputFormatter:[a.inputTransactionFormatter,null]}),r=new o({name:"lockAccount",call:"personal_lockAccount",params:1,inputFormatter:[a.inputAddressFormatter]});return[t,e,n,r]},c=function(){return[new i({name:"listAccounts",getter:"personal_listAccounts"})]};e.exports=r},{"../formatters":30,"../method":36,"../property":45}],41:[function(t,e,n){var r=t("../method"),o=t("../formatters"),i=t("../filter"),a=t("./watches"),s=function(t){this._requestManager=t._requestManager;var e=this;c().forEach(function(t){t.attachToObject(e),t.setRequestManager(e._requestManager)})};s.prototype.filter=function(t,e){return new i(this._requestManager,t,a.shh(),o.outputPostFormatter,e)};var c=function(){var t=new r({name:"post",call:"shh_post",params:1,inputFormatter:[o.inputPostFormatter]}),e=new r({name:"newIdentity",call:"shh_newIdentity",params:0}),n=new r({name:"hasIdentity",call:"shh_hasIdentity",params:1}),i=new r({name:"newGroup",call:"shh_newGroup",params:0}),a=new r({name:"addToGroup",call:"shh_addToGroup",params:0});return[t,e,n,i,a]};e.exports=s},{"../filter":29,"../formatters":30,"../method":36,"./watches":43}],42:[function(t,e,n){"use strict";function r(t){this._requestManager=t._requestManager;var e=this;a().forEach(function(t){t.attachToObject(e),t.setRequestManager(e._requestManager)}),s().forEach(function(t){t.attachToObject(e),t.setRequestManager(e._requestManager)})}var o=t("../method"),i=t("../property"),a=function(){var t=new o({name:"blockNetworkRead",call:"bzz_blockNetworkRead",params:1,inputFormatter:[null]}),e=new o({name:"syncEnabled",call:"bzz_syncEnabled",params:1,inputFormatter:[null]}),n=new o({name:"swapEnabled",call:"bzz_swapEnabled",params:1,inputFormatter:[null]}),r=new o({name:"download",call:"bzz_download",params:2,inputFormatter:[null,null]}),i=new o({name:"upload",call:"bzz_upload",params:2,inputFormatter:[null,null]}),a=new o({name:"retrieve",call:"bzz_retrieve",params:1,inputFormatter:[null]}),s=new o({name:"store",call:"bzz_store",params:2,inputFormatter:[null,null]}),c=new o({name:"get",call:"bzz_get",params:1,inputFormatter:[null]}),u=new o({name:"put",call:"bzz_put",params:2,inputFormatter:[null,null]}),f=new o({name:"modify",call:"bzz_modify",params:4,inputFormatter:[null,null,null,null]});return[t,e,n,r,i,a,s,c,u,f]},s=function(){return[new i({name:"hive",getter:"bzz_hive"}),new i({name:"info",getter:"bzz_info"})]};e.exports=r},{"../method":36,"../property":45}],43:[function(t,e,n){var r=t("../method"),o=function(){var t=function(t){var e=t[0];switch(e){case"latest":return t.shift(),this.params=0,"eth_newBlockFilter";case"pending":return t.shift(),this.params=0,"eth_newPendingTransactionFilter";default:return"eth_newFilter"}},e=new r({name:"newFilter",call:t,params:1}),n=new r({name:"uninstallFilter",call:"eth_uninstallFilter",params:1}),o=new r({name:"getLogs",call:"eth_getFilterLogs",params:1}),i=new r({name:"poll",call:"eth_getFilterChanges",params:1});return[e,n,o,i]},i=function(){var t=new r({name:"newFilter",call:"shh_newFilter",params:1}),e=new r({name:"uninstallFilter",call:"shh_uninstallFilter",params:1}),n=new r({name:"getLogs",call:"shh_getMessages",params:1}),o=new r({name:"poll",call:"shh_getFilterChanges",params:1});return[t,e,n,o]};e.exports={eth:o,shh:i}},{"../method":36}],44:[function(t,e,n){var r=t("../contracts/GlobalRegistrar.json"),o=t("../contracts/ICAPRegistrar.json"),i="0xc6d9d2cd449a754c494264e1809c50e34d64562b",a="0xa1a111bc074c9cfa781f0c38e63bd51c91b8af00";e.exports={global:{abi:r,address:i},icap:{abi:o,address:a}}},{"../contracts/GlobalRegistrar.json":1,"../contracts/ICAPRegistrar.json":2}],45:[function(t,e,n){var r=t("../utils/utils"),o=function(t){this.name=t.name,this.getter=t.getter,this.setter=t.setter,this.outputFormatter=t.outputFormatter,this.inputFormatter=t.inputFormatter,this.requestManager=null};o.prototype.setRequestManager=function(t){this.requestManager=t},o.prototype.formatInput=function(t){return this.inputFormatter?this.inputFormatter(t):t},o.prototype.formatOutput=function(t){return this.outputFormatter&&null!==t&&void 0!==t?this.outputFormatter(t):t},o.prototype.extractCallback=function(t){if(r.isFunction(t[t.length-1]))return t.pop()},o.prototype.attachToObject=function(t){var e={get:this.buildGet(),enumerable:!0},n=this.name.split("."),r=n[0];n.length>1&&(t[n[0]]=t[n[0]]||{},t=t[n[0]],r=n[1]),Object.defineProperty(t,r,e),t[i(r)]=this.buildAsyncGet()};var i=function(t){return"get"+t.charAt(0).toUpperCase()+t.slice(1)};o.prototype.buildGet=function(){var t=this;return function(){return t.formatOutput(t.requestManager.send({method:t.getter}))}},o.prototype.buildAsyncGet=function(){var t=this,e=function(e){t.requestManager.sendAsync({method:t.getter},function(n,r){e(n,t.formatOutput(r))})};return e.request=this.request.bind(this),e},o.prototype.request=function(){var t={method:this.getter,params:[],callback:this.extractCallback(Array.prototype.slice.call(arguments))};return t.format=this.formatOutput.bind(this),t},e.exports=o},{"../utils/utils":20}],46:[function(t,e,n){var r=t("./jsonrpc"),o=t("../utils/utils"),i=t("../utils/config"),a=t("./errors"),s=function(t){this.provider=t,this.polls={},this.timeout=null};s.prototype.send=function(t){if(!this.provider)return console.error(a.InvalidProvider()),null;var e=r.toPayload(t.method,t.params),n=this.provider.send(e);if(!r.isValidResponse(n))throw a.InvalidResponse(n);return n.result},s.prototype.sendAsync=function(t,e){if(!this.provider)return e(a.InvalidProvider());var n=r.toPayload(t.method,t.params);this.provider.sendAsync(n,function(t,n){return t?e(t):r.isValidResponse(n)?void e(null,n.result):e(a.InvalidResponse(n))})},s.prototype.sendBatch=function(t,e){if(!this.provider)return e(a.InvalidProvider());var n=r.toBatchPayload(t);this.provider.sendAsync(n,function(t,n){return t?e(t):o.isArray(n)?void e(t,n):e(a.InvalidResponse(n))})},s.prototype.setProvider=function(t){this.provider=t},s.prototype.startPolling=function(t,e,n,r){this.polls[e]={data:t,id:e,callback:n,uninstall:r},this.timeout||this.poll()},s.prototype.stopPolling=function(t){delete this.polls[t],0===Object.keys(this.polls).length&&this.timeout&&(clearTimeout(this.timeout),this.timeout=null)},s.prototype.reset=function(t){for(var e in this.polls)t&&e.indexOf("syncPoll_")!==-1||(this.polls[e].uninstall(),delete this.polls[e]);0===Object.keys(this.polls).length&&this.timeout&&(clearTimeout(this.timeout),this.timeout=null)},s.prototype.poll=function(){if(this.timeout=setTimeout(this.poll.bind(this),i.ETH_POLLING_TIMEOUT),0!==Object.keys(this.polls).length){if(!this.provider)return void console.error(a.InvalidProvider());var t=[],e=[];for(var n in this.polls)t.push(this.polls[n].data),e.push(n);if(0!==t.length){var s=r.toBatchPayload(t),c={};s.forEach(function(t,n){c[t.id]=e[n]});var u=this;this.provider.sendAsync(s,function(t,e){if(!t){if(!o.isArray(e))throw a.InvalidResponse(e);e.map(function(t){var e=c[t.id];return!!u.polls[e]&&(t.callback=u.polls[e].callback,t)}).filter(function(t){return!!t}).filter(function(t){var e=r.isValidResponse(t);return e||t.callback(a.InvalidResponse(t)),e}).forEach(function(t){t.callback(null,t.result)})}})}}},e.exports=s},{"../utils/config":18,"../utils/utils":20,"./errors":26,"./jsonrpc":35}],47:[function(t,e,n){var r=function(){this.defaultBlock="latest",this.defaultAccount=void 0};e.exports=r},{}],48:[function(t,e,n){var r=t("./formatters"),o=t("../utils/utils"),i=1,a=function(t){var e=function(e,n){return e?t.callbacks.forEach(function(t){t(e)}):(o.isObject(n)&&n.startingBlock&&(n=r.outputSyncingFormatter(n)),void t.callbacks.forEach(function(e){t.lastSyncState!==n&&(!t.lastSyncState&&o.isObject(n)&&e(null,!0),setTimeout(function(){e(null,n)},0),t.lastSyncState=n)}))};t.requestManager.startPolling({method:"eth_syncing",params:[]},t.pollId,e,t.stopWatching.bind(t))},s=function(t,e){return this.requestManager=t,this.pollId="syncPoll_"+i++,this.callbacks=[],this.addCallback(e),this.lastSyncState=!1,a(this),this};s.prototype.addCallback=function(t){return t&&this.callbacks.push(t),this},s.prototype.stopWatching=function(){this.requestManager.stopPolling(this.pollId),this.callbacks=[]},e.exports=s},{"../utils/utils":20,"./formatters":30}],49:[function(t,e,n){var r=t("./iban"),o=t("../contracts/SmartExchange.json"),i=function(t,e,n,o,i){var c=new r(n);if(!c.isValid())throw new Error("invalid iban address");if(c.isDirect())return a(t,e,c.address(),o,i);if(!i){var u=t.icapNamereg().addr(c.institution());return s(t,e,u,o,c.client())}t.icapNamereg().addr(c.institution(),function(n,r){return s(t,e,r,o,c.client(),i)})},a=function(t,e,n,r,o){return t.sendTransaction({address:n,from:e,value:r},o)},s=function(t,e,n,r,i,a){var s=o;return t.contract(s).at(n).deposit(i,{from:e,value:r},a)};e.exports=i},{"../contracts/SmartExchange.json":3,"./iban":33}],50:[function(t,e,n){},{}],51:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./enc-base64"),t("./md5"),t("./evpkdf"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./enc-base64","./md5","./evpkdf","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return function(){var e=t,n=e.lib,r=n.BlockCipher,o=e.algo,i=[],a=[],s=[],c=[],u=[],f=[],l=[],p=[],h=[],d=[];!function(){for(var t=[],e=0;e<256;e++)e<128?t[e]=e<<1:t[e]=e<<1^283;for(var n=0,r=0,e=0;e<256;e++){var o=r^r<<1^r<<2^r<<3^r<<4;o=o>>>8^255&o^99,i[n]=o,a[o]=n;var m=t[n],y=t[m],g=t[y],v=257*t[o]^16843008*o;s[n]=v<<24|v>>>8,c[n]=v<<16|v>>>16,u[n]=v<<8|v>>>24,f[n]=v;var v=16843009*g^65537*y^257*m^16843008*n;l[o]=v<<24|v>>>8,p[o]=v<<16|v>>>16,h[o]=v<<8|v>>>24,d[o]=v,n?(n=m^t[t[t[g^m]]],r^=t[t[r]]):n=r=1}}();var m=[0,1,2,4,8,16,32,64,128,27,54],y=o.AES=r.extend({_doReset:function(){if(!this._nRounds||this._keyPriorReset!==this._key){for(var t=this._keyPriorReset=this._key,e=t.words,n=t.sigBytes/4,r=this._nRounds=n+6,o=4*(r+1),a=this._keySchedule=[],s=0;s<o;s++)if(s<n)a[s]=e[s];else{var c=a[s-1];s%n?n>6&&s%n==4&&(c=i[c>>>24]<<24|i[c>>>16&255]<<16|i[c>>>8&255]<<8|i[255&c]):(c=c<<8|c>>>24,c=i[c>>>24]<<24|i[c>>>16&255]<<16|i[c>>>8&255]<<8|i[255&c],c^=m[s/n|0]<<24),a[s]=a[s-n]^c}for(var u=this._invKeySchedule=[],f=0;f<o;f++){var s=o-f;if(f%4)var c=a[s];else var c=a[s-4];f<4||s<=4?u[f]=c:u[f]=l[i[c>>>24]]^p[i[c>>>16&255]]^h[i[c>>>8&255]]^d[i[255&c]]}}},encryptBlock:function(t,e){this._doCryptBlock(t,e,this._keySchedule,s,c,u,f,i)},decryptBlock:function(t,e){var n=t[e+1];t[e+1]=t[e+3],t[e+3]=n,this._doCryptBlock(t,e,this._invKeySchedule,l,p,h,d,a);var n=t[e+1];t[e+1]=t[e+3],t[e+3]=n},_doCryptBlock:function(t,e,n,r,o,i,a,s){for(var c=this._nRounds,u=t[e]^n[0],f=t[e+1]^n[1],l=t[e+2]^n[2],p=t[e+3]^n[3],h=4,d=1;d<c;d++){
var m=r[u>>>24]^o[f>>>16&255]^i[l>>>8&255]^a[255&p]^n[h++],y=r[f>>>24]^o[l>>>16&255]^i[p>>>8&255]^a[255&u]^n[h++],g=r[l>>>24]^o[p>>>16&255]^i[u>>>8&255]^a[255&f]^n[h++],v=r[p>>>24]^o[u>>>16&255]^i[f>>>8&255]^a[255&l]^n[h++];u=m,f=y,l=g,p=v}var m=(s[u>>>24]<<24|s[f>>>16&255]<<16|s[l>>>8&255]<<8|s[255&p])^n[h++],y=(s[f>>>24]<<24|s[l>>>16&255]<<16|s[p>>>8&255]<<8|s[255&u])^n[h++],g=(s[l>>>24]<<24|s[p>>>16&255]<<16|s[u>>>8&255]<<8|s[255&f])^n[h++],v=(s[p>>>24]<<24|s[u>>>16&255]<<16|s[f>>>8&255]<<8|s[255&l])^n[h++];t[e]=m,t[e+1]=y,t[e+2]=g,t[e+3]=v},keySize:8});e.AES=r._createHelper(y)}(),t.AES})},{"./cipher-core":52,"./core":53,"./enc-base64":54,"./evpkdf":56,"./md5":61}],52:[function(t,e,n){!function(r,o){"object"==typeof n?e.exports=n=o(t("./core")):"function"==typeof define&&define.amd?define(["./core"],o):o(r.CryptoJS)}(this,function(t){t.lib.Cipher||function(e){var n=t,r=n.lib,o=r.Base,i=r.WordArray,a=r.BufferedBlockAlgorithm,s=n.enc,c=(s.Utf8,s.Base64),u=n.algo,f=u.EvpKDF,l=r.Cipher=a.extend({cfg:o.extend(),createEncryptor:function(t,e){return this.create(this._ENC_XFORM_MODE,t,e)},createDecryptor:function(t,e){return this.create(this._DEC_XFORM_MODE,t,e)},init:function(t,e,n){this.cfg=this.cfg.extend(n),this._xformMode=t,this._key=e,this.reset()},reset:function(){a.reset.call(this),this._doReset()},process:function(t){return this._append(t),this._process()},finalize:function(t){t&&this._append(t);var e=this._doFinalize();return e},keySize:4,ivSize:4,_ENC_XFORM_MODE:1,_DEC_XFORM_MODE:2,_createHelper:function(){function t(t){return"string"==typeof t?k:_}return function(e){return{encrypt:function(n,r,o){return t(r).encrypt(e,n,r,o)},decrypt:function(n,r,o){return t(r).decrypt(e,n,r,o)}}}}()}),p=(r.StreamCipher=l.extend({_doFinalize:function(){var t=this._process(!0);return t},blockSize:1}),n.mode={}),h=r.BlockCipherMode=o.extend({createEncryptor:function(t,e){return this.Encryptor.create(t,e)},createDecryptor:function(t,e){return this.Decryptor.create(t,e)},init:function(t,e){this._cipher=t,this._iv=e}}),d=p.CBC=function(){function t(t,n,r){var o=this._iv;if(o){var i=o;this._iv=e}else var i=this._prevBlock;for(var a=0;a<r;a++)t[n+a]^=i[a]}var n=h.extend();return n.Encryptor=n.extend({processBlock:function(e,n){var r=this._cipher,o=r.blockSize;t.call(this,e,n,o),r.encryptBlock(e,n),this._prevBlock=e.slice(n,n+o)}}),n.Decryptor=n.extend({processBlock:function(e,n){var r=this._cipher,o=r.blockSize,i=e.slice(n,n+o);r.decryptBlock(e,n),t.call(this,e,n,o),this._prevBlock=i}}),n}(),m=n.pad={},y=m.Pkcs7={pad:function(t,e){for(var n=4*e,r=n-t.sigBytes%n,o=r<<24|r<<16|r<<8|r,a=[],s=0;s<r;s+=4)a.push(o);var c=i.create(a,r);t.concat(c)},unpad:function(t){var e=255&t.words[t.sigBytes-1>>>2];t.sigBytes-=e}},g=(r.BlockCipher=l.extend({cfg:l.cfg.extend({mode:d,padding:y}),reset:function(){l.reset.call(this);var t=this.cfg,e=t.iv,n=t.mode;if(this._xformMode==this._ENC_XFORM_MODE)var r=n.createEncryptor;else{var r=n.createDecryptor;this._minBufferSize=1}this._mode=r.call(n,this,e&&e.words)},_doProcessBlock:function(t,e){this._mode.processBlock(t,e)},_doFinalize:function(){var t=this.cfg.padding;if(this._xformMode==this._ENC_XFORM_MODE){t.pad(this._data,this.blockSize);var e=this._process(!0)}else{var e=this._process(!0);t.unpad(e)}return e},blockSize:4}),r.CipherParams=o.extend({init:function(t){this.mixIn(t)},toString:function(t){return(t||this.formatter).stringify(this)}})),v=n.format={},b=v.OpenSSL={stringify:function(t){var e=t.ciphertext,n=t.salt;if(n)var r=i.create([1398893684,1701076831]).concat(n).concat(e);else var r=e;return r.toString(c)},parse:function(t){var e=c.parse(t),n=e.words;if(1398893684==n[0]&&1701076831==n[1]){var r=i.create(n.slice(2,4));n.splice(0,4),e.sigBytes-=16}return g.create({ciphertext:e,salt:r})}},_=r.SerializableCipher=o.extend({cfg:o.extend({format:b}),encrypt:function(t,e,n,r){r=this.cfg.extend(r);var o=t.createEncryptor(n,r),i=o.finalize(e),a=o.cfg;return g.create({ciphertext:i,key:n,iv:a.iv,algorithm:t,mode:a.mode,padding:a.padding,blockSize:t.blockSize,formatter:r.format})},decrypt:function(t,e,n,r){r=this.cfg.extend(r),e=this._parse(e,r.format);var o=t.createDecryptor(n,r).finalize(e.ciphertext);return o},_parse:function(t,e){return"string"==typeof t?e.parse(t,this):t}}),w=n.kdf={},x=w.OpenSSL={execute:function(t,e,n,r){r||(r=i.random(8));var o=f.create({keySize:e+n}).compute(t,r),a=i.create(o.words.slice(e),4*n);return o.sigBytes=4*e,g.create({key:o,iv:a,salt:r})}},k=r.PasswordBasedCipher=_.extend({cfg:_.cfg.extend({kdf:x}),encrypt:function(t,e,n,r){r=this.cfg.extend(r);var o=r.kdf.execute(n,t.keySize,t.ivSize);r.iv=o.iv;var i=_.encrypt.call(this,t,e,o.key,r);return i.mixIn(o),i},decrypt:function(t,e,n,r){r=this.cfg.extend(r),e=this._parse(e,r.format);var o=r.kdf.execute(n,t.keySize,t.ivSize,e.salt);r.iv=o.iv;var i=_.decrypt.call(this,t,e,o.key,r);return i}})}()})},{"./core":53}],53:[function(t,e,n){!function(t,r){"object"==typeof n?e.exports=n=r():"function"==typeof define&&define.amd?define([],r):t.CryptoJS=r()}(this,function(){var t=t||function(t,e){var n=Object.create||function(){function t(){}return function(e){var n;return t.prototype=e,n=new t,t.prototype=null,n}}(),r={},o=r.lib={},i=o.Base=function(){return{extend:function(t){var e=n(this);return t&&e.mixIn(t),e.hasOwnProperty("init")&&this.init!==e.init||(e.init=function(){e.$super.init.apply(this,arguments)}),e.init.prototype=e,e.$super=this,e},create:function(){var t=this.extend();return t.init.apply(t,arguments),t},init:function(){},mixIn:function(t){for(var e in t)t.hasOwnProperty(e)&&(this[e]=t[e]);t.hasOwnProperty("toString")&&(this.toString=t.toString)},clone:function(){return this.init.prototype.extend(this)}}}(),a=o.WordArray=i.extend({init:function(t,n){t=this.words=t||[],n!=e?this.sigBytes=n:this.sigBytes=4*t.length},toString:function(t){return(t||c).stringify(this)},concat:function(t){var e=this.words,n=t.words,r=this.sigBytes,o=t.sigBytes;if(this.clamp(),r%4)for(var i=0;i<o;i++){var a=n[i>>>2]>>>24-i%4*8&255;e[r+i>>>2]|=a<<24-(r+i)%4*8}else for(var i=0;i<o;i+=4)e[r+i>>>2]=n[i>>>2];return this.sigBytes+=o,this},clamp:function(){var e=this.words,n=this.sigBytes;e[n>>>2]&=4294967295<<32-n%4*8,e.length=t.ceil(n/4)},clone:function(){var t=i.clone.call(this);return t.words=this.words.slice(0),t},random:function(e){for(var n,r=[],o=function(e){var e=e,n=987654321,r=4294967295;return function(){n=36969*(65535&n)+(n>>16)&r,e=18e3*(65535&e)+(e>>16)&r;var o=(n<<16)+e&r;return o/=4294967296,o+=.5,o*(t.random()>.5?1:-1)}},i=0;i<e;i+=4){var s=o(4294967296*(n||t.random()));n=987654071*s(),r.push(4294967296*s()|0)}return new a.init(r,e)}}),s=r.enc={},c=s.Hex={stringify:function(t){for(var e=t.words,n=t.sigBytes,r=[],o=0;o<n;o++){var i=e[o>>>2]>>>24-o%4*8&255;r.push((i>>>4).toString(16)),r.push((15&i).toString(16))}return r.join("")},parse:function(t){for(var e=t.length,n=[],r=0;r<e;r+=2)n[r>>>3]|=parseInt(t.substr(r,2),16)<<24-r%8*4;return new a.init(n,e/2)}},u=s.Latin1={stringify:function(t){for(var e=t.words,n=t.sigBytes,r=[],o=0;o<n;o++){var i=e[o>>>2]>>>24-o%4*8&255;r.push(String.fromCharCode(i))}return r.join("")},parse:function(t){for(var e=t.length,n=[],r=0;r<e;r++)n[r>>>2]|=(255&t.charCodeAt(r))<<24-r%4*8;return new a.init(n,e)}},f=s.Utf8={stringify:function(t){try{return decodeURIComponent(escape(u.stringify(t)))}catch(t){throw new Error("Malformed UTF-8 data")}},parse:function(t){return u.parse(unescape(encodeURIComponent(t)))}},l=o.BufferedBlockAlgorithm=i.extend({reset:function(){this._data=new a.init,this._nDataBytes=0},_append:function(t){"string"==typeof t&&(t=f.parse(t)),this._data.concat(t),this._nDataBytes+=t.sigBytes},_process:function(e){var n=this._data,r=n.words,o=n.sigBytes,i=this.blockSize,s=4*i,c=o/s;c=e?t.ceil(c):t.max((0|c)-this._minBufferSize,0);var u=c*i,f=t.min(4*u,o);if(u){for(var l=0;l<u;l+=i)this._doProcessBlock(r,l);var p=r.splice(0,u);n.sigBytes-=f}return new a.init(p,f)},clone:function(){var t=i.clone.call(this);return t._data=this._data.clone(),t},_minBufferSize:0}),p=(o.Hasher=l.extend({cfg:i.extend(),init:function(t){this.cfg=this.cfg.extend(t),this.reset()},reset:function(){l.reset.call(this),this._doReset()},update:function(t){return this._append(t),this._process(),this},finalize:function(t){t&&this._append(t);var e=this._doFinalize();return e},blockSize:16,_createHelper:function(t){return function(e,n){return new t.init(n).finalize(e)}},_createHmacHelper:function(t){return function(e,n){return new p.HMAC.init(t,n).finalize(e)}}}),r.algo={});return r}(Math);return t})},{}],54:[function(t,e,n){!function(r,o){"object"==typeof n?e.exports=n=o(t("./core")):"function"==typeof define&&define.amd?define(["./core"],o):o(r.CryptoJS)}(this,function(t){return function(){function e(t,e,n){for(var r=[],i=0,a=0;a<e;a++)if(a%4){var s=n[t.charCodeAt(a-1)]<<a%4*2,c=n[t.charCodeAt(a)]>>>6-a%4*2;r[i>>>2]|=(s|c)<<24-i%4*8,i++}return o.create(r,i)}var n=t,r=n.lib,o=r.WordArray,i=n.enc;i.Base64={stringify:function(t){var e=t.words,n=t.sigBytes,r=this._map;t.clamp();for(var o=[],i=0;i<n;i+=3)for(var a=e[i>>>2]>>>24-i%4*8&255,s=e[i+1>>>2]>>>24-(i+1)%4*8&255,c=e[i+2>>>2]>>>24-(i+2)%4*8&255,u=a<<16|s<<8|c,f=0;f<4&&i+.75*f<n;f++)o.push(r.charAt(u>>>6*(3-f)&63));var l=r.charAt(64);if(l)for(;o.length%4;)o.push(l);return o.join("")},parse:function(t){var n=t.length,r=this._map,o=this._reverseMap;if(!o){o=this._reverseMap=[];for(var i=0;i<r.length;i++)o[r.charCodeAt(i)]=i}var a=r.charAt(64);if(a){var s=t.indexOf(a);s!==-1&&(n=s)}return e(t,n,o)},_map:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="}}(),t.enc.Base64})},{"./core":53}],55:[function(t,e,n){!function(r,o){"object"==typeof n?e.exports=n=o(t("./core")):"function"==typeof define&&define.amd?define(["./core"],o):o(r.CryptoJS)}(this,function(t){return function(){function e(t){return t<<8&4278255360|t>>>8&16711935}var n=t,r=n.lib,o=r.WordArray,i=n.enc;i.Utf16=i.Utf16BE={stringify:function(t){for(var e=t.words,n=t.sigBytes,r=[],o=0;o<n;o+=2){var i=e[o>>>2]>>>16-o%4*8&65535;r.push(String.fromCharCode(i))}return r.join("")},parse:function(t){for(var e=t.length,n=[],r=0;r<e;r++)n[r>>>1]|=t.charCodeAt(r)<<16-r%2*16;return o.create(n,2*e)}};i.Utf16LE={stringify:function(t){for(var n=t.words,r=t.sigBytes,o=[],i=0;i<r;i+=2){var a=e(n[i>>>2]>>>16-i%4*8&65535);o.push(String.fromCharCode(a))}return o.join("")},parse:function(t){for(var n=t.length,r=[],i=0;i<n;i++)r[i>>>1]|=e(t.charCodeAt(i)<<16-i%2*16);return o.create(r,2*n)}}}(),t.enc.Utf16})},{"./core":53}],56:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./sha1"),t("./hmac")):"function"==typeof define&&define.amd?define(["./core","./sha1","./hmac"],o):o(r.CryptoJS)}(this,function(t){return function(){var e=t,n=e.lib,r=n.Base,o=n.WordArray,i=e.algo,a=i.MD5,s=i.EvpKDF=r.extend({cfg:r.extend({keySize:4,hasher:a,iterations:1}),init:function(t){this.cfg=this.cfg.extend(t)},compute:function(t,e){for(var n=this.cfg,r=n.hasher.create(),i=o.create(),a=i.words,s=n.keySize,c=n.iterations;a.length<s;){u&&r.update(u);var u=r.update(t).finalize(e);r.reset();for(var f=1;f<c;f++)u=r.finalize(u),r.reset();i.concat(u)}return i.sigBytes=4*s,i}});e.EvpKDF=function(t,e,n){return s.create(n).compute(t,e)}}(),t.EvpKDF})},{"./core":53,"./hmac":58,"./sha1":77}],57:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return function(e){var n=t,r=n.lib,o=r.CipherParams,i=n.enc,a=i.Hex,s=n.format;s.Hex={stringify:function(t){return t.ciphertext.toString(a)},parse:function(t){var e=a.parse(t);return o.create({ciphertext:e})}}}(),t.format.Hex})},{"./cipher-core":52,"./core":53}],58:[function(t,e,n){!function(r,o){"object"==typeof n?e.exports=n=o(t("./core")):"function"==typeof define&&define.amd?define(["./core"],o):o(r.CryptoJS)}(this,function(t){!function(){var e=t,n=e.lib,r=n.Base,o=e.enc,i=o.Utf8,a=e.algo;a.HMAC=r.extend({init:function(t,e){t=this._hasher=new t.init,"string"==typeof e&&(e=i.parse(e));var n=t.blockSize,r=4*n;e.sigBytes>r&&(e=t.finalize(e)),e.clamp();for(var o=this._oKey=e.clone(),a=this._iKey=e.clone(),s=o.words,c=a.words,u=0;u<n;u++)s[u]^=1549556828,c[u]^=909522486;o.sigBytes=a.sigBytes=r,this.reset()},reset:function(){var t=this._hasher;t.reset(),t.update(this._iKey)},update:function(t){return this._hasher.update(t),this},finalize:function(t){var e=this._hasher,n=e.finalize(t);e.reset();var r=e.finalize(this._oKey.clone().concat(n));return r}})}()})},{"./core":53}],59:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./x64-core"),t("./lib-typedarrays"),t("./enc-utf16"),t("./enc-base64"),t("./md5"),t("./sha1"),t("./sha256"),t("./sha224"),t("./sha512"),t("./sha384"),t("./sha3"),t("./ripemd160"),t("./hmac"),t("./pbkdf2"),t("./evpkdf"),t("./cipher-core"),t("./mode-cfb"),t("./mode-ctr"),t("./mode-ctr-gladman"),t("./mode-ofb"),t("./mode-ecb"),t("./pad-ansix923"),t("./pad-iso10126"),t("./pad-iso97971"),t("./pad-zeropadding"),t("./pad-nopadding"),t("./format-hex"),t("./aes"),t("./tripledes"),t("./rc4"),t("./rabbit"),t("./rabbit-legacy")):"function"==typeof define&&define.amd?define(["./core","./x64-core","./lib-typedarrays","./enc-utf16","./enc-base64","./md5","./sha1","./sha256","./sha224","./sha512","./sha384","./sha3","./ripemd160","./hmac","./pbkdf2","./evpkdf","./cipher-core","./mode-cfb","./mode-ctr","./mode-ctr-gladman","./mode-ofb","./mode-ecb","./pad-ansix923","./pad-iso10126","./pad-iso97971","./pad-zeropadding","./pad-nopadding","./format-hex","./aes","./tripledes","./rc4","./rabbit","./rabbit-legacy"],o):r.CryptoJS=o(r.CryptoJS)}(this,function(t){return t})},{"./aes":51,"./cipher-core":52,"./core":53,"./enc-base64":54,"./enc-utf16":55,"./evpkdf":56,"./format-hex":57,"./hmac":58,"./lib-typedarrays":60,"./md5":61,"./mode-cfb":62,"./mode-ctr":64,"./mode-ctr-gladman":63,"./mode-ecb":65,"./mode-ofb":66,"./pad-ansix923":67,"./pad-iso10126":68,"./pad-iso97971":69,"./pad-nopadding":70,"./pad-zeropadding":71,"./pbkdf2":72,"./rabbit":74,"./rabbit-legacy":73,"./rc4":75,"./ripemd160":76,"./sha1":77,"./sha224":78,"./sha256":79,"./sha3":80,"./sha384":81,"./sha512":82,"./tripledes":83,"./x64-core":84}],60:[function(t,e,n){!function(r,o){"object"==typeof n?e.exports=n=o(t("./core")):"function"==typeof define&&define.amd?define(["./core"],o):o(r.CryptoJS)}(this,function(t){return function(){if("function"==typeof ArrayBuffer){var e=t,n=e.lib,r=n.WordArray,o=r.init,i=r.init=function(t){if(t instanceof ArrayBuffer&&(t=new Uint8Array(t)),(t instanceof Int8Array||"undefined"!=typeof Uint8ClampedArray&&t instanceof Uint8ClampedArray||t instanceof Int16Array||t instanceof Uint16Array||t instanceof Int32Array||t instanceof Uint32Array||t instanceof Float32Array||t instanceof Float64Array)&&(t=new Uint8Array(t.buffer,t.byteOffset,t.byteLength)),t instanceof Uint8Array){for(var e=t.byteLength,n=[],r=0;r<e;r++)n[r>>>2]|=t[r]<<24-r%4*8;o.call(this,n,e)}else o.apply(this,arguments)};i.prototype=r}}(),t.lib.WordArray})},{"./core":53}],61:[function(t,e,n){!function(r,o){"object"==typeof n?e.exports=n=o(t("./core")):"function"==typeof define&&define.amd?define(["./core"],o):o(r.CryptoJS)}(this,function(t){return function(e){function n(t,e,n,r,o,i,a){var s=t+(e&n|~e&r)+o+a;return(s<<i|s>>>32-i)+e}function r(t,e,n,r,o,i,a){var s=t+(e&r|n&~r)+o+a;return(s<<i|s>>>32-i)+e}function o(t,e,n,r,o,i,a){var s=t+(e^n^r)+o+a;return(s<<i|s>>>32-i)+e}function i(t,e,n,r,o,i,a){var s=t+(n^(e|~r))+o+a;return(s<<i|s>>>32-i)+e}var a=t,s=a.lib,c=s.WordArray,u=s.Hasher,f=a.algo,l=[];!function(){for(var t=0;t<64;t++)l[t]=4294967296*e.abs(e.sin(t+1))|0}();var p=f.MD5=u.extend({_doReset:function(){this._hash=new c.init([1732584193,4023233417,2562383102,271733878])},_doProcessBlock:function(t,e){for(var a=0;a<16;a++){var s=e+a,c=t[s];t[s]=16711935&(c<<8|c>>>24)|4278255360&(c<<24|c>>>8)}var u=this._hash.words,f=t[e+0],p=t[e+1],h=t[e+2],d=t[e+3],m=t[e+4],y=t[e+5],g=t[e+6],v=t[e+7],b=t[e+8],_=t[e+9],w=t[e+10],x=t[e+11],k=t[e+12],B=t[e+13],S=t[e+14],C=t[e+15],A=u[0],F=u[1],I=u[2],O=u[3];A=n(A,F,I,O,f,7,l[0]),O=n(O,A,F,I,p,12,l[1]),I=n(I,O,A,F,h,17,l[2]),F=n(F,I,O,A,d,22,l[3]),A=n(A,F,I,O,m,7,l[4]),O=n(O,A,F,I,y,12,l[5]),I=n(I,O,A,F,g,17,l[6]),F=n(F,I,O,A,v,22,l[7]),A=n(A,F,I,O,b,7,l[8]),O=n(O,A,F,I,_,12,l[9]),I=n(I,O,A,F,w,17,l[10]),F=n(F,I,O,A,x,22,l[11]),A=n(A,F,I,O,k,7,l[12]),O=n(O,A,F,I,B,12,l[13]),I=n(I,O,A,F,S,17,l[14]),F=n(F,I,O,A,C,22,l[15]),A=r(A,F,I,O,p,5,l[16]),O=r(O,A,F,I,g,9,l[17]),I=r(I,O,A,F,x,14,l[18]),F=r(F,I,O,A,f,20,l[19]),A=r(A,F,I,O,y,5,l[20]),O=r(O,A,F,I,w,9,l[21]),I=r(I,O,A,F,C,14,l[22]),F=r(F,I,O,A,m,20,l[23]),A=r(A,F,I,O,_,5,l[24]),O=r(O,A,F,I,S,9,l[25]),I=r(I,O,A,F,d,14,l[26]),F=r(F,I,O,A,b,20,l[27]),A=r(A,F,I,O,B,5,l[28]),O=r(O,A,F,I,h,9,l[29]),I=r(I,O,A,F,v,14,l[30]),F=r(F,I,O,A,k,20,l[31]),A=o(A,F,I,O,y,4,l[32]),O=o(O,A,F,I,b,11,l[33]),I=o(I,O,A,F,x,16,l[34]),F=o(F,I,O,A,S,23,l[35]),A=o(A,F,I,O,p,4,l[36]),O=o(O,A,F,I,m,11,l[37]),I=o(I,O,A,F,v,16,l[38]),F=o(F,I,O,A,w,23,l[39]),A=o(A,F,I,O,B,4,l[40]),O=o(O,A,F,I,f,11,l[41]),I=o(I,O,A,F,d,16,l[42]),F=o(F,I,O,A,g,23,l[43]),A=o(A,F,I,O,_,4,l[44]),O=o(O,A,F,I,k,11,l[45]),I=o(I,O,A,F,C,16,l[46]),F=o(F,I,O,A,h,23,l[47]),A=i(A,F,I,O,f,6,l[48]),O=i(O,A,F,I,v,10,l[49]),I=i(I,O,A,F,S,15,l[50]),F=i(F,I,O,A,y,21,l[51]),A=i(A,F,I,O,k,6,l[52]),O=i(O,A,F,I,d,10,l[53]),I=i(I,O,A,F,w,15,l[54]),F=i(F,I,O,A,p,21,l[55]),A=i(A,F,I,O,b,6,l[56]),O=i(O,A,F,I,C,10,l[57]),I=i(I,O,A,F,g,15,l[58]),F=i(F,I,O,A,B,21,l[59]),A=i(A,F,I,O,m,6,l[60]),O=i(O,A,F,I,x,10,l[61]),I=i(I,O,A,F,h,15,l[62]),F=i(F,I,O,A,_,21,l[63]),u[0]=u[0]+A|0,u[1]=u[1]+F|0,u[2]=u[2]+I|0,u[3]=u[3]+O|0},_doFinalize:function(){var t=this._data,n=t.words,r=8*this._nDataBytes,o=8*t.sigBytes;n[o>>>5]|=128<<24-o%32;var i=e.floor(r/4294967296),a=r;n[(o+64>>>9<<4)+15]=16711935&(i<<8|i>>>24)|4278255360&(i<<24|i>>>8),n[(o+64>>>9<<4)+14]=16711935&(a<<8|a>>>24)|4278255360&(a<<24|a>>>8),t.sigBytes=4*(n.length+1),this._process();for(var s=this._hash,c=s.words,u=0;u<4;u++){var f=c[u];c[u]=16711935&(f<<8|f>>>24)|4278255360&(f<<24|f>>>8)}return s},clone:function(){var t=u.clone.call(this);return t._hash=this._hash.clone(),t}});a.MD5=u._createHelper(p),a.HmacMD5=u._createHmacHelper(p)}(Math),t.MD5})},{"./core":53}],62:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return t.mode.CFB=function(){function e(t,e,n,r){var o=this._iv;if(o){var i=o.slice(0);this._iv=void 0}else var i=this._prevBlock;r.encryptBlock(i,0);for(var a=0;a<n;a++)t[e+a]^=i[a]}var n=t.lib.BlockCipherMode.extend();return n.Encryptor=n.extend({processBlock:function(t,n){var r=this._cipher,o=r.blockSize;e.call(this,t,n,o,r),this._prevBlock=t.slice(n,n+o)}}),n.Decryptor=n.extend({processBlock:function(t,n){var r=this._cipher,o=r.blockSize,i=t.slice(n,n+o);e.call(this,t,n,o,r),this._prevBlock=i}}),n}(),t.mode.CFB})},{"./cipher-core":52,"./core":53}],63:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return t.mode.CTRGladman=function(){function e(t){if(255===(t>>24&255)){var e=t>>16&255,n=t>>8&255,r=255&t;255===e?(e=0,255===n?(n=0,255===r?r=0:++r):++n):++e,t=0,t+=e<<16,t+=n<<8,t+=r}else t+=1<<24;return t}function n(t){return 0===(t[0]=e(t[0]))&&(t[1]=e(t[1])),t}var r=t.lib.BlockCipherMode.extend(),o=r.Encryptor=r.extend({processBlock:function(t,e){var r=this._cipher,o=r.blockSize,i=this._iv,a=this._counter;i&&(a=this._counter=i.slice(0),this._iv=void 0),n(a);var s=a.slice(0);r.encryptBlock(s,0);for(var c=0;c<o;c++)t[e+c]^=s[c]}});return r.Decryptor=o,r}(),t.mode.CTRGladman})},{"./cipher-core":52,"./core":53}],64:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return t.mode.CTR=function(){var e=t.lib.BlockCipherMode.extend(),n=e.Encryptor=e.extend({processBlock:function(t,e){var n=this._cipher,r=n.blockSize,o=this._iv,i=this._counter;o&&(i=this._counter=o.slice(0),this._iv=void 0);var a=i.slice(0);n.encryptBlock(a,0),i[r-1]=i[r-1]+1|0;for(var s=0;s<r;s++)t[e+s]^=a[s]}});return e.Decryptor=n,e}(),t.mode.CTR})},{"./cipher-core":52,"./core":53}],65:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return t.mode.ECB=function(){var e=t.lib.BlockCipherMode.extend();return e.Encryptor=e.extend({processBlock:function(t,e){this._cipher.encryptBlock(t,e)}}),e.Decryptor=e.extend({processBlock:function(t,e){this._cipher.decryptBlock(t,e)}}),e}(),t.mode.ECB})},{"./cipher-core":52,"./core":53}],66:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return t.mode.OFB=function(){var e=t.lib.BlockCipherMode.extend(),n=e.Encryptor=e.extend({processBlock:function(t,e){var n=this._cipher,r=n.blockSize,o=this._iv,i=this._keystream;o&&(i=this._keystream=o.slice(0),this._iv=void 0),n.encryptBlock(i,0);for(var a=0;a<r;a++)t[e+a]^=i[a]}});return e.Decryptor=n,e}(),t.mode.OFB})},{"./cipher-core":52,"./core":53}],67:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return t.pad.AnsiX923={pad:function(t,e){var n=t.sigBytes,r=4*e,o=r-n%r,i=n+o-1;t.clamp(),t.words[i>>>2]|=o<<24-i%4*8,t.sigBytes+=o},unpad:function(t){var e=255&t.words[t.sigBytes-1>>>2];t.sigBytes-=e}},t.pad.Ansix923})},{"./cipher-core":52,"./core":53}],68:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return t.pad.Iso10126={pad:function(e,n){var r=4*n,o=r-e.sigBytes%r;e.concat(t.lib.WordArray.random(o-1)).concat(t.lib.WordArray.create([o<<24],1))},unpad:function(t){var e=255&t.words[t.sigBytes-1>>>2];t.sigBytes-=e}},t.pad.Iso10126})},{"./cipher-core":52,"./core":53}],69:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return t.pad.Iso97971={pad:function(e,n){e.concat(t.lib.WordArray.create([2147483648],1)),t.pad.ZeroPadding.pad(e,n)},unpad:function(e){t.pad.ZeroPadding.unpad(e),e.sigBytes--}},t.pad.Iso97971})},{"./cipher-core":52,"./core":53}],70:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return t.pad.NoPadding={pad:function(){},unpad:function(){}},t.pad.NoPadding})},{"./cipher-core":52,"./core":53}],71:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return t.pad.ZeroPadding={pad:function(t,e){var n=4*e;t.clamp(),t.sigBytes+=n-(t.sigBytes%n||n)},unpad:function(t){for(var e=t.words,n=t.sigBytes-1;!(e[n>>>2]>>>24-n%4*8&255);)n--;t.sigBytes=n+1}},t.pad.ZeroPadding})},{"./cipher-core":52,"./core":53}],72:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./sha1"),t("./hmac")):"function"==typeof define&&define.amd?define(["./core","./sha1","./hmac"],o):o(r.CryptoJS)}(this,function(t){return function(){var e=t,n=e.lib,r=n.Base,o=n.WordArray,i=e.algo,a=i.SHA1,s=i.HMAC,c=i.PBKDF2=r.extend({cfg:r.extend({keySize:4,hasher:a,iterations:1}),init:function(t){this.cfg=this.cfg.extend(t)},compute:function(t,e){for(var n=this.cfg,r=s.create(n.hasher,t),i=o.create(),a=o.create([1]),c=i.words,u=a.words,f=n.keySize,l=n.iterations;c.length<f;){var p=r.update(e).finalize(a);r.reset();for(var h=p.words,d=h.length,m=p,y=1;y<l;y++){m=r.finalize(m),r.reset();for(var g=m.words,v=0;v<d;v++)h[v]^=g[v]}i.concat(p),u[0]++}return i.sigBytes=4*f,i}});e.PBKDF2=function(t,e,n){return c.create(n).compute(t,e)}}(),t.PBKDF2})},{"./core":53,"./hmac":58,"./sha1":77}],73:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./enc-base64"),t("./md5"),t("./evpkdf"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./enc-base64","./md5","./evpkdf","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return function(){function e(){for(var t=this._X,e=this._C,n=0;n<8;n++)s[n]=e[n];e[0]=e[0]+1295307597+this._b|0,e[1]=e[1]+3545052371+(e[0]>>>0<s[0]>>>0?1:0)|0,e[2]=e[2]+886263092+(e[1]>>>0<s[1]>>>0?1:0)|0,e[3]=e[3]+1295307597+(e[2]>>>0<s[2]>>>0?1:0)|0,e[4]=e[4]+3545052371+(e[3]>>>0<s[3]>>>0?1:0)|0,e[5]=e[5]+886263092+(e[4]>>>0<s[4]>>>0?1:0)|0,e[6]=e[6]+1295307597+(e[5]>>>0<s[5]>>>0?1:0)|0,e[7]=e[7]+3545052371+(e[6]>>>0<s[6]>>>0?1:0)|0,this._b=e[7]>>>0<s[7]>>>0?1:0;for(var n=0;n<8;n++){var r=t[n]+e[n],o=65535&r,i=r>>>16,a=((o*o>>>17)+o*i>>>15)+i*i,u=((4294901760&r)*r|0)+((65535&r)*r|0);c[n]=a^u}t[0]=c[0]+(c[7]<<16|c[7]>>>16)+(c[6]<<16|c[6]>>>16)|0,t[1]=c[1]+(c[0]<<8|c[0]>>>24)+c[7]|0,t[2]=c[2]+(c[1]<<16|c[1]>>>16)+(c[0]<<16|c[0]>>>16)|0,t[3]=c[3]+(c[2]<<8|c[2]>>>24)+c[1]|0,t[4]=c[4]+(c[3]<<16|c[3]>>>16)+(c[2]<<16|c[2]>>>16)|0,t[5]=c[5]+(c[4]<<8|c[4]>>>24)+c[3]|0,t[6]=c[6]+(c[5]<<16|c[5]>>>16)+(c[4]<<16|c[4]>>>16)|0,t[7]=c[7]+(c[6]<<8|c[6]>>>24)+c[5]|0}var n=t,r=n.lib,o=r.StreamCipher,i=n.algo,a=[],s=[],c=[],u=i.RabbitLegacy=o.extend({_doReset:function(){var t=this._key.words,n=this.cfg.iv,r=this._X=[t[0],t[3]<<16|t[2]>>>16,t[1],t[0]<<16|t[3]>>>16,t[2],t[1]<<16|t[0]>>>16,t[3],t[2]<<16|t[1]>>>16],o=this._C=[t[2]<<16|t[2]>>>16,4294901760&t[0]|65535&t[1],t[3]<<16|t[3]>>>16,4294901760&t[1]|65535&t[2],t[0]<<16|t[0]>>>16,4294901760&t[2]|65535&t[3],t[1]<<16|t[1]>>>16,4294901760&t[3]|65535&t[0]];this._b=0;for(var i=0;i<4;i++)e.call(this);for(var i=0;i<8;i++)o[i]^=r[i+4&7];if(n){var a=n.words,s=a[0],c=a[1],u=16711935&(s<<8|s>>>24)|4278255360&(s<<24|s>>>8),f=16711935&(c<<8|c>>>24)|4278255360&(c<<24|c>>>8),l=u>>>16|4294901760&f,p=f<<16|65535&u;o[0]^=u,o[1]^=l,o[2]^=f,o[3]^=p,o[4]^=u,o[5]^=l,o[6]^=f,o[7]^=p;for(var i=0;i<4;i++)e.call(this)}},_doProcessBlock:function(t,n){var r=this._X;e.call(this),a[0]=r[0]^r[5]>>>16^r[3]<<16,a[1]=r[2]^r[7]>>>16^r[5]<<16,a[2]=r[4]^r[1]>>>16^r[7]<<16,a[3]=r[6]^r[3]>>>16^r[1]<<16;for(var o=0;o<4;o++)a[o]=16711935&(a[o]<<8|a[o]>>>24)|4278255360&(a[o]<<24|a[o]>>>8),t[n+o]^=a[o]},blockSize:4,ivSize:2});n.RabbitLegacy=o._createHelper(u)}(),t.RabbitLegacy})},{"./cipher-core":52,"./core":53,"./enc-base64":54,"./evpkdf":56,"./md5":61}],74:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./enc-base64"),t("./md5"),t("./evpkdf"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./enc-base64","./md5","./evpkdf","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return function(){function e(){for(var t=this._X,e=this._C,n=0;n<8;n++)s[n]=e[n];e[0]=e[0]+1295307597+this._b|0,e[1]=e[1]+3545052371+(e[0]>>>0<s[0]>>>0?1:0)|0,e[2]=e[2]+886263092+(e[1]>>>0<s[1]>>>0?1:0)|0,e[3]=e[3]+1295307597+(e[2]>>>0<s[2]>>>0?1:0)|0,e[4]=e[4]+3545052371+(e[3]>>>0<s[3]>>>0?1:0)|0,e[5]=e[5]+886263092+(e[4]>>>0<s[4]>>>0?1:0)|0,e[6]=e[6]+1295307597+(e[5]>>>0<s[5]>>>0?1:0)|0,e[7]=e[7]+3545052371+(e[6]>>>0<s[6]>>>0?1:0)|0,this._b=e[7]>>>0<s[7]>>>0?1:0;for(var n=0;n<8;n++){var r=t[n]+e[n],o=65535&r,i=r>>>16,a=((o*o>>>17)+o*i>>>15)+i*i,u=((4294901760&r)*r|0)+((65535&r)*r|0);c[n]=a^u}t[0]=c[0]+(c[7]<<16|c[7]>>>16)+(c[6]<<16|c[6]>>>16)|0,t[1]=c[1]+(c[0]<<8|c[0]>>>24)+c[7]|0,t[2]=c[2]+(c[1]<<16|c[1]>>>16)+(c[0]<<16|c[0]>>>16)|0,t[3]=c[3]+(c[2]<<8|c[2]>>>24)+c[1]|0,t[4]=c[4]+(c[3]<<16|c[3]>>>16)+(c[2]<<16|c[2]>>>16)|0,t[5]=c[5]+(c[4]<<8|c[4]>>>24)+c[3]|0,t[6]=c[6]+(c[5]<<16|c[5]>>>16)+(c[4]<<16|c[4]>>>16)|0,t[7]=c[7]+(c[6]<<8|c[6]>>>24)+c[5]|0}var n=t,r=n.lib,o=r.StreamCipher,i=n.algo,a=[],s=[],c=[],u=i.Rabbit=o.extend({_doReset:function(){for(var t=this._key.words,n=this.cfg.iv,r=0;r<4;r++)t[r]=16711935&(t[r]<<8|t[r]>>>24)|4278255360&(t[r]<<24|t[r]>>>8);var o=this._X=[t[0],t[3]<<16|t[2]>>>16,t[1],t[0]<<16|t[3]>>>16,t[2],t[1]<<16|t[0]>>>16,t[3],t[2]<<16|t[1]>>>16],i=this._C=[t[2]<<16|t[2]>>>16,4294901760&t[0]|65535&t[1],t[3]<<16|t[3]>>>16,4294901760&t[1]|65535&t[2],t[0]<<16|t[0]>>>16,4294901760&t[2]|65535&t[3],t[1]<<16|t[1]>>>16,4294901760&t[3]|65535&t[0]];this._b=0;for(var r=0;r<4;r++)e.call(this);for(var r=0;r<8;r++)i[r]^=o[r+4&7];if(n){var a=n.words,s=a[0],c=a[1],u=16711935&(s<<8|s>>>24)|4278255360&(s<<24|s>>>8),f=16711935&(c<<8|c>>>24)|4278255360&(c<<24|c>>>8),l=u>>>16|4294901760&f,p=f<<16|65535&u;i[0]^=u,i[1]^=l,i[2]^=f,i[3]^=p,i[4]^=u,i[5]^=l,i[6]^=f,i[7]^=p;for(var r=0;r<4;r++)e.call(this)}},_doProcessBlock:function(t,n){var r=this._X;e.call(this),a[0]=r[0]^r[5]>>>16^r[3]<<16,a[1]=r[2]^r[7]>>>16^r[5]<<16,a[2]=r[4]^r[1]>>>16^r[7]<<16,a[3]=r[6]^r[3]>>>16^r[1]<<16;for(var o=0;o<4;o++)a[o]=16711935&(a[o]<<8|a[o]>>>24)|4278255360&(a[o]<<24|a[o]>>>8),t[n+o]^=a[o]},blockSize:4,ivSize:2});n.Rabbit=o._createHelper(u)}(),t.Rabbit})},{"./cipher-core":52,"./core":53,"./enc-base64":54,"./evpkdf":56,"./md5":61}],75:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./enc-base64"),t("./md5"),t("./evpkdf"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./enc-base64","./md5","./evpkdf","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return function(){function e(){for(var t=this._S,e=this._i,n=this._j,r=0,o=0;o<4;o++){e=(e+1)%256,n=(n+t[e])%256;var i=t[e];t[e]=t[n],t[n]=i,r|=t[(t[e]+t[n])%256]<<24-8*o}return this._i=e,this._j=n,r}var n=t,r=n.lib,o=r.StreamCipher,i=n.algo,a=i.RC4=o.extend({_doReset:function(){for(var t=this._key,e=t.words,n=t.sigBytes,r=this._S=[],o=0;o<256;o++)r[o]=o;for(var o=0,i=0;o<256;o++){var a=o%n,s=e[a>>>2]>>>24-a%4*8&255;i=(i+r[o]+s)%256;var c=r[o];r[o]=r[i],r[i]=c}this._i=this._j=0},_doProcessBlock:function(t,n){t[n]^=e.call(this)},keySize:8,ivSize:0});n.RC4=o._createHelper(a);var s=i.RC4Drop=a.extend({cfg:a.cfg.extend({drop:192}),_doReset:function(){a._doReset.call(this);for(var t=this.cfg.drop;t>0;t--)e.call(this)}});n.RC4Drop=o._createHelper(s)}(),t.RC4})},{"./cipher-core":52,"./core":53,"./enc-base64":54,"./evpkdf":56,"./md5":61}],76:[function(t,e,n){!function(r,o){"object"==typeof n?e.exports=n=o(t("./core")):"function"==typeof define&&define.amd?define(["./core"],o):o(r.CryptoJS)}(this,function(t){return function(e){function n(t,e,n){return t^e^n}function r(t,e,n){return t&e|~t&n}function o(t,e,n){return(t|~e)^n}function i(t,e,n){return t&n|e&~n}function a(t,e,n){return t^(e|~n)}function s(t,e){return t<<e|t>>>32-e}var c=t,u=c.lib,f=u.WordArray,l=u.Hasher,p=c.algo,h=f.create([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13]),d=f.create([5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11]),m=f.create([11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6]),y=f.create([8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11]),g=f.create([0,1518500249,1859775393,2400959708,2840853838]),v=f.create([1352829926,1548603684,1836072691,2053994217,0]),b=p.RIPEMD160=l.extend({
_doReset:function(){this._hash=f.create([1732584193,4023233417,2562383102,271733878,3285377520])},_doProcessBlock:function(t,e){for(var c=0;c<16;c++){var u=e+c,f=t[u];t[u]=16711935&(f<<8|f>>>24)|4278255360&(f<<24|f>>>8)}var l,p,b,_,w,x,k,B,S,C,A=this._hash.words,F=g.words,I=v.words,O=h.words,N=d.words,T=m.words,D=y.words;x=l=A[0],k=p=A[1],B=b=A[2],S=_=A[3],C=w=A[4];for(var E,c=0;c<80;c+=1)E=l+t[e+O[c]]|0,E+=c<16?n(p,b,_)+F[0]:c<32?r(p,b,_)+F[1]:c<48?o(p,b,_)+F[2]:c<64?i(p,b,_)+F[3]:a(p,b,_)+F[4],E=0|E,E=s(E,T[c]),E=E+w|0,l=w,w=_,_=s(b,10),b=p,p=E,E=x+t[e+N[c]]|0,E+=c<16?a(k,B,S)+I[0]:c<32?i(k,B,S)+I[1]:c<48?o(k,B,S)+I[2]:c<64?r(k,B,S)+I[3]:n(k,B,S)+I[4],E=0|E,E=s(E,D[c]),E=E+C|0,x=C,C=S,S=s(B,10),B=k,k=E;E=A[1]+b+S|0,A[1]=A[2]+_+C|0,A[2]=A[3]+w+x|0,A[3]=A[4]+l+k|0,A[4]=A[0]+p+B|0,A[0]=E},_doFinalize:function(){var t=this._data,e=t.words,n=8*this._nDataBytes,r=8*t.sigBytes;e[r>>>5]|=128<<24-r%32,e[(r+64>>>9<<4)+14]=16711935&(n<<8|n>>>24)|4278255360&(n<<24|n>>>8),t.sigBytes=4*(e.length+1),this._process();for(var o=this._hash,i=o.words,a=0;a<5;a++){var s=i[a];i[a]=16711935&(s<<8|s>>>24)|4278255360&(s<<24|s>>>8)}return o},clone:function(){var t=l.clone.call(this);return t._hash=this._hash.clone(),t}});c.RIPEMD160=l._createHelper(b),c.HmacRIPEMD160=l._createHmacHelper(b)}(Math),t.RIPEMD160})},{"./core":53}],77:[function(t,e,n){!function(r,o){"object"==typeof n?e.exports=n=o(t("./core")):"function"==typeof define&&define.amd?define(["./core"],o):o(r.CryptoJS)}(this,function(t){return function(){var e=t,n=e.lib,r=n.WordArray,o=n.Hasher,i=e.algo,a=[],s=i.SHA1=o.extend({_doReset:function(){this._hash=new r.init([1732584193,4023233417,2562383102,271733878,3285377520])},_doProcessBlock:function(t,e){for(var n=this._hash.words,r=n[0],o=n[1],i=n[2],s=n[3],c=n[4],u=0;u<80;u++){if(u<16)a[u]=0|t[e+u];else{var f=a[u-3]^a[u-8]^a[u-14]^a[u-16];a[u]=f<<1|f>>>31}var l=(r<<5|r>>>27)+c+a[u];l+=u<20?(o&i|~o&s)+1518500249:u<40?(o^i^s)+1859775393:u<60?(o&i|o&s|i&s)-1894007588:(o^i^s)-899497514,c=s,s=i,i=o<<30|o>>>2,o=r,r=l}n[0]=n[0]+r|0,n[1]=n[1]+o|0,n[2]=n[2]+i|0,n[3]=n[3]+s|0,n[4]=n[4]+c|0},_doFinalize:function(){var t=this._data,e=t.words,n=8*this._nDataBytes,r=8*t.sigBytes;return e[r>>>5]|=128<<24-r%32,e[(r+64>>>9<<4)+14]=Math.floor(n/4294967296),e[(r+64>>>9<<4)+15]=n,t.sigBytes=4*e.length,this._process(),this._hash},clone:function(){var t=o.clone.call(this);return t._hash=this._hash.clone(),t}});e.SHA1=o._createHelper(s),e.HmacSHA1=o._createHmacHelper(s)}(),t.SHA1})},{"./core":53}],78:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./sha256")):"function"==typeof define&&define.amd?define(["./core","./sha256"],o):o(r.CryptoJS)}(this,function(t){return function(){var e=t,n=e.lib,r=n.WordArray,o=e.algo,i=o.SHA256,a=o.SHA224=i.extend({_doReset:function(){this._hash=new r.init([3238371032,914150663,812702999,4144912697,4290775857,1750603025,1694076839,3204075428])},_doFinalize:function(){var t=i._doFinalize.call(this);return t.sigBytes-=4,t}});e.SHA224=i._createHelper(a),e.HmacSHA224=i._createHmacHelper(a)}(),t.SHA224})},{"./core":53,"./sha256":79}],79:[function(t,e,n){!function(r,o){"object"==typeof n?e.exports=n=o(t("./core")):"function"==typeof define&&define.amd?define(["./core"],o):o(r.CryptoJS)}(this,function(t){return function(e){var n=t,r=n.lib,o=r.WordArray,i=r.Hasher,a=n.algo,s=[],c=[];!function(){function t(t){for(var n=e.sqrt(t),r=2;r<=n;r++)if(!(t%r))return!1;return!0}function n(t){return 4294967296*(t-(0|t))|0}for(var r=2,o=0;o<64;)t(r)&&(o<8&&(s[o]=n(e.pow(r,.5))),c[o]=n(e.pow(r,1/3)),o++),r++}();var u=[],f=a.SHA256=i.extend({_doReset:function(){this._hash=new o.init(s.slice(0))},_doProcessBlock:function(t,e){for(var n=this._hash.words,r=n[0],o=n[1],i=n[2],a=n[3],s=n[4],f=n[5],l=n[6],p=n[7],h=0;h<64;h++){if(h<16)u[h]=0|t[e+h];else{var d=u[h-15],m=(d<<25|d>>>7)^(d<<14|d>>>18)^d>>>3,y=u[h-2],g=(y<<15|y>>>17)^(y<<13|y>>>19)^y>>>10;u[h]=m+u[h-7]+g+u[h-16]}var v=s&f^~s&l,b=r&o^r&i^o&i,_=(r<<30|r>>>2)^(r<<19|r>>>13)^(r<<10|r>>>22),w=(s<<26|s>>>6)^(s<<21|s>>>11)^(s<<7|s>>>25),x=p+w+v+c[h]+u[h],k=_+b;p=l,l=f,f=s,s=a+x|0,a=i,i=o,o=r,r=x+k|0}n[0]=n[0]+r|0,n[1]=n[1]+o|0,n[2]=n[2]+i|0,n[3]=n[3]+a|0,n[4]=n[4]+s|0,n[5]=n[5]+f|0,n[6]=n[6]+l|0,n[7]=n[7]+p|0},_doFinalize:function(){var t=this._data,n=t.words,r=8*this._nDataBytes,o=8*t.sigBytes;return n[o>>>5]|=128<<24-o%32,n[(o+64>>>9<<4)+14]=e.floor(r/4294967296),n[(o+64>>>9<<4)+15]=r,t.sigBytes=4*n.length,this._process(),this._hash},clone:function(){var t=i.clone.call(this);return t._hash=this._hash.clone(),t}});n.SHA256=i._createHelper(f),n.HmacSHA256=i._createHmacHelper(f)}(Math),t.SHA256})},{"./core":53}],80:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./x64-core")):"function"==typeof define&&define.amd?define(["./core","./x64-core"],o):o(r.CryptoJS)}(this,function(t){return function(e){var n=t,r=n.lib,o=r.WordArray,i=r.Hasher,a=n.x64,s=a.Word,c=n.algo,u=[],f=[],l=[];!function(){for(var t=1,e=0,n=0;n<24;n++){u[t+5*e]=(n+1)*(n+2)/2%64;var r=e%5,o=(2*t+3*e)%5;t=r,e=o}for(var t=0;t<5;t++)for(var e=0;e<5;e++)f[t+5*e]=e+(2*t+3*e)%5*5;for(var i=1,a=0;a<24;a++){for(var c=0,p=0,h=0;h<7;h++){if(1&i){var d=(1<<h)-1;d<32?p^=1<<d:c^=1<<d-32}128&i?i=i<<1^113:i<<=1}l[a]=s.create(c,p)}}();var p=[];!function(){for(var t=0;t<25;t++)p[t]=s.create()}();var h=c.SHA3=i.extend({cfg:i.cfg.extend({outputLength:512}),_doReset:function(){for(var t=this._state=[],e=0;e<25;e++)t[e]=new s.init;this.blockSize=(1600-2*this.cfg.outputLength)/32},_doProcessBlock:function(t,e){for(var n=this._state,r=this.blockSize/2,o=0;o<r;o++){var i=t[e+2*o],a=t[e+2*o+1];i=16711935&(i<<8|i>>>24)|4278255360&(i<<24|i>>>8),a=16711935&(a<<8|a>>>24)|4278255360&(a<<24|a>>>8);var s=n[o];s.high^=a,s.low^=i}for(var c=0;c<24;c++){for(var h=0;h<5;h++){for(var d=0,m=0,y=0;y<5;y++){var s=n[h+5*y];d^=s.high,m^=s.low}var g=p[h];g.high=d,g.low=m}for(var h=0;h<5;h++)for(var v=p[(h+4)%5],b=p[(h+1)%5],_=b.high,w=b.low,d=v.high^(_<<1|w>>>31),m=v.low^(w<<1|_>>>31),y=0;y<5;y++){var s=n[h+5*y];s.high^=d,s.low^=m}for(var x=1;x<25;x++){var s=n[x],k=s.high,B=s.low,S=u[x];if(S<32)var d=k<<S|B>>>32-S,m=B<<S|k>>>32-S;else var d=B<<S-32|k>>>64-S,m=k<<S-32|B>>>64-S;var C=p[f[x]];C.high=d,C.low=m}var A=p[0],F=n[0];A.high=F.high,A.low=F.low;for(var h=0;h<5;h++)for(var y=0;y<5;y++){var x=h+5*y,s=n[x],I=p[x],O=p[(h+1)%5+5*y],N=p[(h+2)%5+5*y];s.high=I.high^~O.high&N.high,s.low=I.low^~O.low&N.low}var s=n[0],T=l[c];s.high^=T.high,s.low^=T.low}},_doFinalize:function(){var t=this._data,n=t.words,r=(8*this._nDataBytes,8*t.sigBytes),i=32*this.blockSize;n[r>>>5]|=1<<24-r%32,n[(e.ceil((r+1)/i)*i>>>5)-1]|=128,t.sigBytes=4*n.length,this._process();for(var a=this._state,s=this.cfg.outputLength/8,c=s/8,u=[],f=0;f<c;f++){var l=a[f],p=l.high,h=l.low;p=16711935&(p<<8|p>>>24)|4278255360&(p<<24|p>>>8),h=16711935&(h<<8|h>>>24)|4278255360&(h<<24|h>>>8),u.push(h),u.push(p)}return new o.init(u,s)},clone:function(){for(var t=i.clone.call(this),e=t._state=this._state.slice(0),n=0;n<25;n++)e[n]=e[n].clone();return t}});n.SHA3=i._createHelper(h),n.HmacSHA3=i._createHmacHelper(h)}(Math),t.SHA3})},{"./core":53,"./x64-core":84}],81:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./x64-core"),t("./sha512")):"function"==typeof define&&define.amd?define(["./core","./x64-core","./sha512"],o):o(r.CryptoJS)}(this,function(t){return function(){var e=t,n=e.x64,r=n.Word,o=n.WordArray,i=e.algo,a=i.SHA512,s=i.SHA384=a.extend({_doReset:function(){this._hash=new o.init([new r.init(3418070365,3238371032),new r.init(1654270250,914150663),new r.init(2438529370,812702999),new r.init(355462360,4144912697),new r.init(1731405415,4290775857),new r.init(2394180231,1750603025),new r.init(3675008525,1694076839),new r.init(1203062813,3204075428)])},_doFinalize:function(){var t=a._doFinalize.call(this);return t.sigBytes-=16,t}});e.SHA384=a._createHelper(s),e.HmacSHA384=a._createHmacHelper(s)}(),t.SHA384})},{"./core":53,"./sha512":82,"./x64-core":84}],82:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./x64-core")):"function"==typeof define&&define.amd?define(["./core","./x64-core"],o):o(r.CryptoJS)}(this,function(t){return function(){function e(){return a.create.apply(a,arguments)}var n=t,r=n.lib,o=r.Hasher,i=n.x64,a=i.Word,s=i.WordArray,c=n.algo,u=[e(1116352408,3609767458),e(1899447441,602891725),e(3049323471,3964484399),e(3921009573,2173295548),e(961987163,4081628472),e(1508970993,3053834265),e(2453635748,2937671579),e(2870763221,3664609560),e(3624381080,2734883394),e(310598401,1164996542),e(607225278,1323610764),e(1426881987,3590304994),e(1925078388,4068182383),e(2162078206,991336113),e(2614888103,633803317),e(3248222580,3479774868),e(3835390401,2666613458),e(4022224774,944711139),e(264347078,2341262773),e(604807628,2007800933),e(770255983,1495990901),e(1249150122,1856431235),e(1555081692,3175218132),e(1996064986,2198950837),e(2554220882,3999719339),e(2821834349,766784016),e(2952996808,2566594879),e(3210313671,3203337956),e(3336571891,1034457026),e(3584528711,2466948901),e(113926993,3758326383),e(338241895,168717936),e(666307205,1188179964),e(773529912,1546045734),e(1294757372,1522805485),e(1396182291,2643833823),e(1695183700,2343527390),e(1986661051,1014477480),e(2177026350,1206759142),e(2456956037,344077627),e(2730485921,1290863460),e(2820302411,3158454273),e(3259730800,3505952657),e(3345764771,106217008),e(3516065817,3606008344),e(3600352804,1432725776),e(4094571909,1467031594),e(275423344,851169720),e(430227734,3100823752),e(506948616,1363258195),e(659060556,3750685593),e(883997877,3785050280),e(958139571,3318307427),e(1322822218,3812723403),e(1537002063,2003034995),e(1747873779,3602036899),e(1955562222,1575990012),e(2024104815,1125592928),e(2227730452,2716904306),e(2361852424,442776044),e(2428436474,593698344),e(2756734187,3733110249),e(3204031479,2999351573),e(3329325298,3815920427),e(3391569614,3928383900),e(3515267271,566280711),e(3940187606,3454069534),e(4118630271,4000239992),e(116418474,1914138554),e(174292421,2731055270),e(289380356,3203993006),e(460393269,320620315),e(685471733,587496836),e(852142971,1086792851),e(1017036298,365543100),e(1126000580,2618297676),e(1288033470,3409855158),e(1501505948,4234509866),e(1607167915,987167468),e(1816402316,1246189591)],f=[];!function(){for(var t=0;t<80;t++)f[t]=e()}();var l=c.SHA512=o.extend({_doReset:function(){this._hash=new s.init([new a.init(1779033703,4089235720),new a.init(3144134277,2227873595),new a.init(1013904242,4271175723),new a.init(2773480762,1595750129),new a.init(1359893119,2917565137),new a.init(2600822924,725511199),new a.init(528734635,4215389547),new a.init(1541459225,327033209)])},_doProcessBlock:function(t,e){for(var n=this._hash.words,r=n[0],o=n[1],i=n[2],a=n[3],s=n[4],c=n[5],l=n[6],p=n[7],h=r.high,d=r.low,m=o.high,y=o.low,g=i.high,v=i.low,b=a.high,_=a.low,w=s.high,x=s.low,k=c.high,B=c.low,S=l.high,C=l.low,A=p.high,F=p.low,I=h,O=d,N=m,T=y,D=g,E=v,P=b,R=_,M=w,H=x,j=k,q=B,z=S,L=C,U=A,W=F,J=0;J<80;J++){var G=f[J];if(J<16)var X=G.high=0|t[e+2*J],$=G.low=0|t[e+2*J+1];else{var V=f[J-15],K=V.high,Z=V.low,Y=(K>>>1|Z<<31)^(K>>>8|Z<<24)^K>>>7,Q=(Z>>>1|K<<31)^(Z>>>8|K<<24)^(Z>>>7|K<<25),tt=f[J-2],et=tt.high,nt=tt.low,rt=(et>>>19|nt<<13)^(et<<3|nt>>>29)^et>>>6,ot=(nt>>>19|et<<13)^(nt<<3|et>>>29)^(nt>>>6|et<<26),it=f[J-7],at=it.high,st=it.low,ct=f[J-16],ut=ct.high,ft=ct.low,$=Q+st,X=Y+at+($>>>0<Q>>>0?1:0),$=$+ot,X=X+rt+($>>>0<ot>>>0?1:0),$=$+ft,X=X+ut+($>>>0<ft>>>0?1:0);G.high=X,G.low=$}var lt=M&j^~M&z,pt=H&q^~H&L,ht=I&N^I&D^N&D,dt=O&T^O&E^T&E,mt=(I>>>28|O<<4)^(I<<30|O>>>2)^(I<<25|O>>>7),yt=(O>>>28|I<<4)^(O<<30|I>>>2)^(O<<25|I>>>7),gt=(M>>>14|H<<18)^(M>>>18|H<<14)^(M<<23|H>>>9),vt=(H>>>14|M<<18)^(H>>>18|M<<14)^(H<<23|M>>>9),bt=u[J],_t=bt.high,wt=bt.low,xt=W+vt,kt=U+gt+(xt>>>0<W>>>0?1:0),xt=xt+pt,kt=kt+lt+(xt>>>0<pt>>>0?1:0),xt=xt+wt,kt=kt+_t+(xt>>>0<wt>>>0?1:0),xt=xt+$,kt=kt+X+(xt>>>0<$>>>0?1:0),Bt=yt+dt,St=mt+ht+(Bt>>>0<yt>>>0?1:0);U=z,W=L,z=j,L=q,j=M,q=H,H=R+xt|0,M=P+kt+(H>>>0<R>>>0?1:0)|0,P=D,R=E,D=N,E=T,N=I,T=O,O=xt+Bt|0,I=kt+St+(O>>>0<xt>>>0?1:0)|0}d=r.low=d+O,r.high=h+I+(d>>>0<O>>>0?1:0),y=o.low=y+T,o.high=m+N+(y>>>0<T>>>0?1:0),v=i.low=v+E,i.high=g+D+(v>>>0<E>>>0?1:0),_=a.low=_+R,a.high=b+P+(_>>>0<R>>>0?1:0),x=s.low=x+H,s.high=w+M+(x>>>0<H>>>0?1:0),B=c.low=B+q,c.high=k+j+(B>>>0<q>>>0?1:0),C=l.low=C+L,l.high=S+z+(C>>>0<L>>>0?1:0),F=p.low=F+W,p.high=A+U+(F>>>0<W>>>0?1:0)},_doFinalize:function(){var t=this._data,e=t.words,n=8*this._nDataBytes,r=8*t.sigBytes;e[r>>>5]|=128<<24-r%32,e[(r+128>>>10<<5)+30]=Math.floor(n/4294967296),e[(r+128>>>10<<5)+31]=n,t.sigBytes=4*e.length,this._process();var o=this._hash.toX32();return o},clone:function(){var t=o.clone.call(this);return t._hash=this._hash.clone(),t},blockSize:32});n.SHA512=o._createHelper(l),n.HmacSHA512=o._createHmacHelper(l)}(),t.SHA512})},{"./core":53,"./x64-core":84}],83:[function(t,e,n){!function(r,o,i){"object"==typeof n?e.exports=n=o(t("./core"),t("./enc-base64"),t("./md5"),t("./evpkdf"),t("./cipher-core")):"function"==typeof define&&define.amd?define(["./core","./enc-base64","./md5","./evpkdf","./cipher-core"],o):o(r.CryptoJS)}(this,function(t){return function(){function e(t,e){var n=(this._lBlock>>>t^this._rBlock)&e;this._rBlock^=n,this._lBlock^=n<<t}function n(t,e){var n=(this._rBlock>>>t^this._lBlock)&e;this._lBlock^=n,this._rBlock^=n<<t}var r=t,o=r.lib,i=o.WordArray,a=o.BlockCipher,s=r.algo,c=[57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4],u=[14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32],f=[1,2,4,6,8,10,12,14,15,17,19,21,23,25,27,28],l=[{0:8421888,268435456:32768,536870912:8421378,805306368:2,1073741824:512,1342177280:8421890,1610612736:8389122,1879048192:8388608,2147483648:514,2415919104:8389120,2684354560:33280,2952790016:8421376,3221225472:32770,3489660928:8388610,3758096384:0,4026531840:33282,134217728:0,402653184:8421890,671088640:33282,939524096:32768,1207959552:8421888,1476395008:512,1744830464:8421378,2013265920:2,2281701376:8389120,2550136832:33280,2818572288:8421376,3087007744:8389122,3355443200:8388610,3623878656:32770,3892314112:514,4160749568:8388608,1:32768,268435457:2,536870913:8421888,805306369:8388608,1073741825:8421378,1342177281:33280,1610612737:512,1879048193:8389122,2147483649:8421890,2415919105:8421376,2684354561:8388610,2952790017:33282,3221225473:514,3489660929:8389120,3758096385:32770,4026531841:0,134217729:8421890,402653185:8421376,671088641:8388608,939524097:512,1207959553:32768,1476395009:8388610,1744830465:2,2013265921:33282,2281701377:32770,2550136833:8389122,2818572289:514,3087007745:8421888,3355443201:8389120,3623878657:0,3892314113:33280,4160749569:8421378},{0:1074282512,16777216:16384,33554432:524288,50331648:1074266128,67108864:1073741840,83886080:1074282496,100663296:1073758208,117440512:16,134217728:540672,150994944:1073758224,167772160:1073741824,184549376:540688,201326592:524304,218103808:0,234881024:16400,251658240:1074266112,8388608:1073758208,25165824:540688,41943040:16,58720256:1073758224,75497472:1074282512,92274688:1073741824,109051904:524288,125829120:1074266128,142606336:524304,159383552:0,176160768:16384,192937984:1074266112,209715200:1073741840,226492416:540672,243269632:1074282496,260046848:16400,268435456:0,285212672:1074266128,301989888:1073758224,318767104:1074282496,335544320:1074266112,352321536:16,369098752:540688,385875968:16384,402653184:16400,419430400:524288,436207616:524304,452984832:1073741840,469762048:540672,486539264:1073758208,503316480:1073741824,520093696:1074282512,276824064:540688,293601280:524288,310378496:1074266112,327155712:16384,343932928:1073758208,360710144:1074282512,377487360:16,394264576:1073741824,411041792:1074282496,427819008:1073741840,444596224:1073758224,461373440:524304,478150656:0,494927872:16400,511705088:1074266128,528482304:540672},{0:260,1048576:0,2097152:67109120,3145728:65796,4194304:65540,5242880:67108868,6291456:67174660,7340032:67174400,8388608:67108864,9437184:67174656,10485760:65792,11534336:67174404,12582912:67109124,13631488:65536,14680064:4,15728640:256,524288:67174656,1572864:67174404,2621440:0,3670016:67109120,4718592:67108868,5767168:65536,6815744:65540,7864320:260,8912896:4,9961472:256,11010048:67174400,12058624:65796,13107200:65792,14155776:67109124,15204352:67174660,16252928:67108864,16777216:67174656,17825792:65540,18874368:65536,19922944:67109120,20971520:256,22020096:67174660,23068672:67108868,24117248:0,25165824:67109124,26214400:67108864,27262976:4,28311552:65792,29360128:67174400,30408704:260,31457280:65796,32505856:67174404,17301504:67108864,18350080:260,19398656:67174656,20447232:0,21495808:65540,22544384:67109120,23592960:256,24641536:67174404,25690112:65536,26738688:67174660,27787264:65796,28835840:67108868,29884416:67109124,30932992:67174400,31981568:4,33030144:65792},{0:2151682048,65536:2147487808,131072:4198464,196608:2151677952,262144:0,327680:4198400,393216:2147483712,458752:4194368,524288:2147483648,589824:4194304,655360:64,720896:2147487744,786432:2151678016,851968:4160,917504:4096,983040:2151682112,32768:2147487808,98304:64,163840:2151678016,229376:2147487744,294912:4198400,360448:2151682112,425984:0,491520:2151677952,557056:4096,622592:2151682048,688128:4194304,753664:4160,819200:2147483648,884736:4194368,950272:4198464,1015808:2147483712,1048576:4194368,1114112:4198400,1179648:2147483712,1245184:0,1310720:4160,1376256:2151678016,1441792:2151682048,1507328:2147487808,1572864:2151682112,1638400:2147483648,1703936:2151677952,1769472:4198464,1835008:2147487744,1900544:4194304,1966080:64,2031616:4096,1081344:2151677952,1146880:2151682112,1212416:0,1277952:4198400,1343488:4194368,1409024:2147483648,1474560:2147487808,1540096:64,1605632:2147483712,1671168:4096,1736704:2147487744,1802240:2151678016,1867776:4160,1933312:2151682048,1998848:4194304,2064384:4198464},{0:128,4096:17039360,8192:262144,12288:536870912,16384:537133184,20480:16777344,24576:553648256,28672:262272,32768:16777216,36864:537133056,40960:536871040,45056:553910400,49152:553910272,53248:0,57344:17039488,61440:553648128,2048:17039488,6144:553648256,10240:128,14336:17039360,18432:262144,22528:537133184,26624:553910272,30720:536870912,34816:537133056,38912:0,43008:553910400,47104:16777344,51200:536871040,55296:553648128,59392:16777216,63488:262272,65536:262144,69632:128,73728:536870912,77824:553648256,81920:16777344,86016:553910272,90112:537133184,94208:16777216,98304:553910400,102400:553648128,106496:17039360,110592:537133056,114688:262272,118784:536871040,122880:0,126976:17039488,67584:553648256,71680:16777216,75776:17039360,79872:537133184,83968:536870912,88064:17039488,92160:128,96256:553910272,100352:262272,104448:553910400,108544:0,112640:553648128,116736:16777344,120832:262144,124928:537133056,129024:536871040},{0:268435464,256:8192,512:270532608,768:270540808,1024:268443648,1280:2097152,1536:2097160,1792:268435456,2048:0,2304:268443656,2560:2105344,2816:8,3072:270532616,3328:2105352,3584:8200,3840:270540800,128:270532608,384:270540808,640:8,896:2097152,1152:2105352,1408:268435464,1664:268443648,1920:8200,2176:2097160,2432:8192,2688:268443656,2944:270532616,3200:0,3456:270540800,3712:2105344,3968:268435456,4096:268443648,4352:270532616,4608:270540808,4864:8200,5120:2097152,5376:268435456,5632:268435464,5888:2105344,6144:2105352,6400:0,6656:8,6912:270532608,7168:8192,7424:268443656,7680:270540800,7936:2097160,4224:8,4480:2105344,4736:2097152,4992:268435464,5248:268443648,5504:8200,5760:270540808,6016:270532608,6272:270540800,6528:270532616,6784:8192,7040:2105352,7296:2097160,7552:0,7808:268435456,8064:268443656},{0:1048576,16:33555457,32:1024,48:1049601,64:34604033,80:0,96:1,112:34603009,128:33555456,144:1048577,160:33554433,176:34604032,192:34603008,208:1025,224:1049600,240:33554432,8:34603009,24:0,40:33555457,56:34604032,72:1048576,88:33554433,104:33554432,120:1025,136:1049601,152:33555456,168:34603008,184:1048577,200:1024,216:34604033,232:1,248:1049600,256:33554432,272:1048576,288:33555457,304:34603009,320:1048577,336:33555456,352:34604032,368:1049601,384:1025,400:34604033,416:1049600,432:1,448:0,464:34603008,480:33554433,496:1024,264:1049600,280:33555457,296:34603009,312:1,328:33554432,344:1048576,360:1025,376:34604032,392:33554433,408:34603008,424:0,440:34604033,456:1049601,472:1024,488:33555456,504:1048577},{0:134219808,1:131072,2:134217728,3:32,4:131104,5:134350880,6:134350848,7:2048,8:134348800,9:134219776,10:133120,11:134348832,12:2080,13:0,14:134217760,15:133152,2147483648:2048,2147483649:134350880,2147483650:134219808,2147483651:134217728,2147483652:134348800,2147483653:133120,2147483654:133152,2147483655:32,2147483656:134217760,2147483657:2080,2147483658:131104,2147483659:134350848,2147483660:0,2147483661:134348832,2147483662:134219776,2147483663:131072,16:133152,17:134350848,18:32,19:2048,20:134219776,21:134217760,22:134348832,23:131072,24:0,25:131104,26:134348800,27:134219808,28:134350880,29:133120,30:2080,31:134217728,2147483664:131072,2147483665:2048,2147483666:134348832,2147483667:133152,2147483668:32,2147483669:134348800,2147483670:134217728,2147483671:134219808,2147483672:134350880,2147483673:134217760,2147483674:134219776,2147483675:0,2147483676:133120,2147483677:2080,2147483678:131104,2147483679:134350848}],p=[4160749569,528482304,33030144,2064384,129024,8064,504,2147483679],h=s.DES=a.extend({_doReset:function(){for(var t=this._key,e=t.words,n=[],r=0;r<56;r++){var o=c[r]-1;n[r]=e[o>>>5]>>>31-o%32&1}for(var i=this._subKeys=[],a=0;a<16;a++){for(var s=i[a]=[],l=f[a],r=0;r<24;r++)s[r/6|0]|=n[(u[r]-1+l)%28]<<31-r%6,s[4+(r/6|0)]|=n[28+(u[r+24]-1+l)%28]<<31-r%6;s[0]=s[0]<<1|s[0]>>>31;for(var r=1;r<7;r++)s[r]=s[r]>>>4*(r-1)+3;s[7]=s[7]<<5|s[7]>>>27}for(var p=this._invSubKeys=[],r=0;r<16;r++)p[r]=i[15-r]},encryptBlock:function(t,e){this._doCryptBlock(t,e,this._subKeys)},decryptBlock:function(t,e){this._doCryptBlock(t,e,this._invSubKeys)},_doCryptBlock:function(t,r,o){this._lBlock=t[r],this._rBlock=t[r+1],e.call(this,4,252645135),e.call(this,16,65535),n.call(this,2,858993459),n.call(this,8,16711935),e.call(this,1,1431655765);for(var i=0;i<16;i++){for(var a=o[i],s=this._lBlock,c=this._rBlock,u=0,f=0;f<8;f++)u|=l[f][((c^a[f])&p[f])>>>0];this._lBlock=c,this._rBlock=s^u}var h=this._lBlock;this._lBlock=this._rBlock,this._rBlock=h,e.call(this,1,1431655765),n.call(this,8,16711935),n.call(this,2,858993459),e.call(this,16,65535),e.call(this,4,252645135),t[r]=this._lBlock,t[r+1]=this._rBlock},keySize:2,ivSize:2,blockSize:2});r.DES=a._createHelper(h);var d=s.TripleDES=a.extend({_doReset:function(){var t=this._key,e=t.words;this._des1=h.createEncryptor(i.create(e.slice(0,2))),this._des2=h.createEncryptor(i.create(e.slice(2,4))),this._des3=h.createEncryptor(i.create(e.slice(4,6)))},encryptBlock:function(t,e){this._des1.encryptBlock(t,e),this._des2.decryptBlock(t,e),this._des3.encryptBlock(t,e)},decryptBlock:function(t,e){this._des3.decryptBlock(t,e),this._des2.encryptBlock(t,e),this._des1.decryptBlock(t,e)},keySize:6,ivSize:2,blockSize:2});r.TripleDES=a._createHelper(d)}(),t.TripleDES})},{"./cipher-core":52,"./core":53,"./enc-base64":54,"./evpkdf":56,"./md5":61}],84:[function(t,e,n){!function(r,o){"object"==typeof n?e.exports=n=o(t("./core")):"function"==typeof define&&define.amd?define(["./core"],o):o(r.CryptoJS)}(this,function(t){return function(e){var n=t,r=n.lib,o=r.Base,i=r.WordArray,a=n.x64={};a.Word=o.extend({init:function(t,e){this.high=t,this.low=e}}),a.WordArray=o.extend({init:function(t,n){t=this.words=t||[],n!=e?this.sigBytes=n:this.sigBytes=8*t.length},toX32:function(){for(var t=this.words,e=t.length,n=[],r=0;r<e;r++){var o=t[r];n.push(o.high),n.push(o.low)}return i.create(n,this.sigBytes)},clone:function(){for(var t=o.clone.call(this),e=t.words=this.words.slice(0),n=e.length,r=0;r<n;r++)e[r]=e[r].clone();return t}})}(),t})},{"./core":53}],85:[function(t,e,n){!function(t){function r(t){for(var e,n,r=[],o=0,i=t.length;o<i;)e=t.charCodeAt(o++),e>=55296&&e<=56319&&o<i?(n=t.charCodeAt(o++),56320==(64512&n)?r.push(((1023&e)<<10)+(1023&n)+65536):(r.push(e),o--)):r.push(e);return r}function o(t){for(var e,n=t.length,r=-1,o="";++r<n;)e=t[r],e>65535&&(e-=65536,o+=v(e>>>10&1023|55296),e=56320|1023&e),o+=v(e);return o}function i(t){if(t>=55296&&t<=57343)throw Error("Lone surrogate U+"+t.toString(16).toUpperCase()+" is not a scalar value")}function a(t,e){return v(t>>e&63|128)}function s(t){if(0==(4294967168&t))return v(t);var e="";return 0==(4294965248&t)?e=v(t>>6&31|192):0==(4294901760&t)?(i(t),e=v(t>>12&15|224),e+=a(t,6)):0==(4292870144&t)&&(e=v(t>>18&7|240),e+=a(t,12),e+=a(t,6)),e+=v(63&t|128)}function c(t){for(var e,n=r(t),o=n.length,i=-1,a="";++i<o;)e=n[i],a+=s(e);return a}function u(){if(g>=y)throw Error("Invalid byte index");var t=255&m[g];if(g++,128==(192&t))return 63&t;throw Error("Invalid continuation byte")}function f(){var t,e,n,r,o;if(g>y)throw Error("Invalid byte index");if(g==y)return!1;if(t=255&m[g],g++,0==(128&t))return t;if(192==(224&t)){if(e=u(),o=(31&t)<<6|e,o>=128)return o;throw Error("Invalid continuation byte")}if(224==(240&t)){if(e=u(),n=u(),o=(15&t)<<12|e<<6|n,o>=2048)return i(o),o;throw Error("Invalid continuation byte")}if(240==(248&t)&&(e=u(),n=u(),r=u(),o=(7&t)<<18|e<<12|n<<6|r,o>=65536&&o<=1114111))return o;throw Error("Invalid UTF-8 detected")}function l(t){m=r(t),y=m.length,g=0;for(var e,n=[];(e=f())!==!1;)n.push(e);return o(n)}var p="object"==typeof n&&n,h="object"==typeof e&&e&&e.exports==p&&e,d="object"==typeof global&&global;d.global!==d&&d.window!==d||(t=d);var m,y,g,v=String.fromCharCode,b={version:"2.1.2",encode:c,decode:l};if("function"==typeof define&&"object"==typeof define.amd&&define.amd)define(function(){return b});else if(p&&!p.nodeType)if(h)h.exports=b;else{var _={},w=_.hasOwnProperty;for(var x in b)w.call(b,x)&&(p[x]=b[x])}else t.utf8=b}(this)},{}],86:[function(t,e,n){e.exports=XMLHttpRequest},{}],"bignumber.js":[function(t,e,n){!function(n){"use strict";function r(t){function e(t,r){var o,i,a,s,c,u,f=this;if(!(f instanceof e))return W&&T(26,"constructor call without new",t),new e(t,r);if(null!=r&&J(r,2,64,P,"base")){if(r=0|r,u=t+"",10==r)return f=new e(t instanceof e?t:u),D(f,H+f.e+1,j);if((s="number"==typeof t)&&0*t!=0||!new RegExp("^-?"+(o="["+x.slice(0,r)+"]+")+"(?:\\."+o+")?$",r<37?"i":"").test(u))return m(f,u,s,r);s?(f.s=1/t<0?(u=u.slice(1),-1):1,W&&u.replace(/^0\.0*|\./,"").length>15&&T(P,w,t),s=!1):f.s=45===u.charCodeAt(0)?(u=u.slice(1),-1):1,u=n(u,10,r,f.s)}else{if(t instanceof e)return f.s=t.s,f.e=t.e,f.c=(t=t.c)?t.slice():t,void(P=0);if((s="number"==typeof t)&&0*t==0){if(f.s=1/t<0?(t=-t,-1):1,t===~~t){for(i=0,a=t;a>=10;a/=10,i++);return f.e=i,f.c=[t],void(P=0)}u=t+""}else{if(!y.test(u=t+""))return m(f,u,s);f.s=45===u.charCodeAt(0)?(u=u.slice(1),-1):1}}for((i=u.indexOf("."))>-1&&(u=u.replace(".","")),(a=u.search(/e/i))>0?(i<0&&(i=a),i+=+u.slice(a+1),u=u.substring(0,a)):i<0&&(i=u.length),a=0;48===u.charCodeAt(a);a++);for(c=u.length;48===u.charCodeAt(--c););if(u=u.slice(a,c+1))if(c=u.length,s&&W&&c>15&&T(P,w,f.s*t),i=i-a-1,i>U)f.c=f.e=null;else if(i<L)f.c=[f.e=0];else{if(f.e=i,f.c=[],a=(i+1)%B,i<0&&(a+=B),a<c){for(a&&f.c.push(+u.slice(0,a)),c-=B;a<c;)f.c.push(+u.slice(a,a+=B));u=u.slice(a),a=B-u.length}else a-=c;for(;a--;u+="0");f.c.push(+u)}else f.c=[f.e=0];P=0}function n(t,n,r,o){var a,s,c,f,p,h,d,m=t.indexOf("."),y=H,g=j;for(r<37&&(t=t.toLowerCase()),m>=0&&(c=$,$=0,t=t.replace(".",""),d=new e(r),p=d.pow(t.length-m),$=c,d.c=u(l(i(p.c),p.e),10,n),d.e=d.c.length),h=u(t,r,n),s=c=h.length;0==h[--c];h.pop());if(!h[0])return"0";if(m<0?--s:(p.c=h,p.e=s,p.s=o,p=E(p,d,y,g,n),h=p.c,f=p.r,s=p.e),a=s+y+1,m=h[a],c=n/2,f=f||a<0||null!=h[a+1],f=g<4?(null!=m||f)&&(0==g||g==(p.s<0?3:2)):m>c||m==c&&(4==g||f||6==g&&1&h[a-1]||g==(p.s<0?8:7)),a<1||!h[0])t=f?l("1",-y):"0";else{if(h.length=a,f)for(--n;++h[--a]>n;)h[a]=0,a||(++s,h.unshift(1));for(c=h.length;!h[--c];);for(m=0,t="";m<=c;t+=x.charAt(h[m++]));t=l(t,s)}return t}function h(t,n,r,o){var a,s,c,u,p;if(r=null!=r&&J(r,0,8,o,_)?0|r:j,!t.c)return t.toString();if(a=t.c[0],c=t.e,null==n)p=i(t.c),p=19==o||24==o&&c<=q?f(p,c):l(p,c);else if(t=D(new e(t),n,r),s=t.e,p=i(t.c),u=p.length,19==o||24==o&&(n<=s||s<=q)){for(;u<n;p+="0",u++);p=f(p,s)}else if(n-=c,p=l(p,s),s+1>u){if(--n>0)for(p+=".";n--;p+="0");}else if(n+=s-u,n>0)for(s+1==u&&(p+=".");n--;p+="0");return t.s<0&&a?"-"+p:p}function I(t,n){var r,o,i=0;for(c(t[0])&&(t=t[0]),r=new e(t[0]);++i<t.length;){if(o=new e(t[i]),!o.s){r=o;break}n.call(r,o)&&(r=o)}return r}function O(t,e,n,r,o){return(t<e||t>n||t!=p(t))&&T(r,(o||"decimal places")+(t<e||t>n?" out of range":" not an integer"),t),!0}function N(t,e,n){for(var r=1,o=e.length;!e[--o];e.pop());for(o=e[0];o>=10;o/=10,r++);return(n=r+n*B-1)>U?t.c=t.e=null:n<L?t.c=[t.e=0]:(t.e=n,t.c=e),t}function T(t,e,n){var r=new Error(["new BigNumber","cmp","config","div","divToInt","eq","gt","gte","lt","lte","minus","mod","plus","precision","random","round","shift","times","toDigits","toExponential","toFixed","toFormat","toFraction","pow","toPrecision","toString","BigNumber"][t]+"() "+e+": "+n);throw r.name="BigNumber Error",P=0,r}function D(t,e,n,r){var o,i,a,s,c,u,f,l=t.c,p=C;if(l){t:{for(o=1,s=l[0];s>=10;s/=10,o++);if(i=e-o,i<0)i+=B,a=e,c=l[u=0],f=c/p[o-a-1]%10|0;else if(u=g((i+1)/B),u>=l.length){if(!r)break t;for(;l.length<=u;l.push(0));c=f=0,o=1,i%=B,a=i-B+1}else{for(c=s=l[u],o=1;s>=10;s/=10,o++);i%=B,a=i-B+o,f=a<0?0:c/p[o-a-1]%10|0}if(r=r||e<0||null!=l[u+1]||(a<0?c:c%p[o-a-1]),r=n<4?(f||r)&&(0==n||n==(t.s<0?3:2)):f>5||5==f&&(4==n||r||6==n&&(i>0?a>0?c/p[o-a]:0:l[u-1])%10&1||n==(t.s<0?8:7)),e<1||!l[0])return l.length=0,r?(e-=t.e+1,l[0]=p[e%B],t.e=-e||0):l[0]=t.e=0,t;if(0==i?(l.length=u,s=1,u--):(l.length=u+1,s=p[B-i],l[u]=a>0?v(c/p[o-a]%p[a])*s:0),r)for(;;){if(0==u){for(i=1,a=l[0];a>=10;a/=10,i++);for(a=l[0]+=s,s=1;a>=10;a/=10,s++);i!=s&&(t.e++,l[0]==k&&(l[0]=1));break}if(l[u]+=s,l[u]!=k)break;l[u--]=0,s=1}for(i=l.length;0===l[--i];l.pop());}t.e>U?t.c=t.e=null:t.e<L&&(t.c=[t.e=0])}return t}var E,P=0,R=e.prototype,M=new e(1),H=20,j=4,q=-7,z=21,L=-1e7,U=1e7,W=!0,J=O,G=!1,X=1,$=100,V={decimalSeparator:".",groupSeparator:",",groupSize:3,secondaryGroupSize:0,fractionGroupSeparator:" ",fractionGroupSize:0};return e.another=r,e.ROUND_UP=0,e.ROUND_DOWN=1,e.ROUND_CEIL=2,e.ROUND_FLOOR=3,e.ROUND_HALF_UP=4,e.ROUND_HALF_DOWN=5,e.ROUND_HALF_EVEN=6,e.ROUND_HALF_CEIL=7,e.ROUND_HALF_FLOOR=8,e.EUCLID=9,e.config=function(){var t,e,n=0,r={},o=arguments,i=o[0],a=i&&"object"==typeof i?function(){if(i.hasOwnProperty(e))return null!=(t=i[e])}:function(){if(o.length>n)return null!=(t=o[n++])};return a(e="DECIMAL_PLACES")&&J(t,0,F,2,e)&&(H=0|t),r[e]=H,a(e="ROUNDING_MODE")&&J(t,0,8,2,e)&&(j=0|t),r[e]=j,a(e="EXPONENTIAL_AT")&&(c(t)?J(t[0],-F,0,2,e)&&J(t[1],0,F,2,e)&&(q=0|t[0],z=0|t[1]):J(t,-F,F,2,e)&&(q=-(z=0|(t<0?-t:t)))),r[e]=[q,z],a(e="RANGE")&&(c(t)?J(t[0],-F,-1,2,e)&&J(t[1],1,F,2,e)&&(L=0|t[0],U=0|t[1]):J(t,-F,F,2,e)&&(0|t?L=-(U=0|(t<0?-t:t)):W&&T(2,e+" cannot be zero",t))),r[e]=[L,U],a(e="ERRORS")&&(t===!!t||1===t||0===t?(P=0,J=(W=!!t)?O:s):W&&T(2,e+b,t)),r[e]=W,a(e="CRYPTO")&&(t===!!t||1===t||0===t?(G=!(!t||!d||"object"!=typeof d),t&&!G&&W&&T(2,"crypto unavailable",d)):W&&T(2,e+b,t)),r[e]=G,a(e="MODULO_MODE")&&J(t,0,9,2,e)&&(X=0|t),r[e]=X,a(e="POW_PRECISION")&&J(t,0,F,2,e)&&($=0|t),r[e]=$,a(e="FORMAT")&&("object"==typeof t?V=t:W&&T(2,e+" not an object",t)),r[e]=V,r},e.max=function(){return I(arguments,R.lt)},e.min=function(){return I(arguments,R.gt)},e.random=function(){var t=9007199254740992,n=Math.random()*t&2097151?function(){return v(Math.random()*t)}:function(){return 8388608*(1073741824*Math.random()|0)+(8388608*Math.random()|0)};return function(t){var r,o,i,a,s,c=0,u=[],f=new e(M);if(t=null!=t&&J(t,0,F,14)?0|t:H,a=g(t/B),G)if(d&&d.getRandomValues){for(r=d.getRandomValues(new Uint32Array(a*=2));c<a;)s=131072*r[c]+(r[c+1]>>>11),s>=9e15?(o=d.getRandomValues(new Uint32Array(2)),r[c]=o[0],
r[c+1]=o[1]):(u.push(s%1e14),c+=2);c=a/2}else if(d&&d.randomBytes){for(r=d.randomBytes(a*=7);c<a;)s=281474976710656*(31&r[c])+1099511627776*r[c+1]+4294967296*r[c+2]+16777216*r[c+3]+(r[c+4]<<16)+(r[c+5]<<8)+r[c+6],s>=9e15?d.randomBytes(7).copy(r,c):(u.push(s%1e14),c+=7);c=a/7}else W&&T(14,"crypto unavailable",d);if(!c)for(;c<a;)s=n(),s<9e15&&(u[c++]=s%1e14);for(a=u[--c],t%=B,a&&t&&(s=C[B-t],u[c]=v(a/s)*s);0===u[c];u.pop(),c--);if(c<0)u=[i=0];else{for(i=-1;0===u[0];u.shift(),i-=B);for(c=1,s=u[0];s>=10;s/=10,c++);c<B&&(i-=B-c)}return f.e=i,f.c=u,f}}(),E=function(){function t(t,e,n){var r,o,i,a,s=0,c=t.length,u=e%A,f=e/A|0;for(t=t.slice();c--;)i=t[c]%A,a=t[c]/A|0,r=f*i+a*u,o=u*i+r%A*A+s,s=(o/n|0)+(r/A|0)+f*a,t[c]=o%n;return s&&t.unshift(s),t}function n(t,e,n,r){var o,i;if(n!=r)i=n>r?1:-1;else for(o=i=0;o<n;o++)if(t[o]!=e[o]){i=t[o]>e[o]?1:-1;break}return i}function r(t,e,n,r){for(var o=0;n--;)t[n]-=o,o=t[n]<e[n]?1:0,t[n]=o*r+t[n]-e[n];for(;!t[0]&&t.length>1;t.shift());}return function(i,a,s,c,u){var f,l,p,h,d,m,y,g,b,_,w,x,S,C,A,F,I,O=i.s==a.s?1:-1,N=i.c,T=a.c;if(!(N&&N[0]&&T&&T[0]))return new e(i.s&&a.s&&(N?!T||N[0]!=T[0]:T)?N&&0==N[0]||!T?0*O:O/0:NaN);for(g=new e(O),b=g.c=[],l=i.e-a.e,O=s+l+1,u||(u=k,l=o(i.e/B)-o(a.e/B),O=O/B|0),p=0;T[p]==(N[p]||0);p++);if(T[p]>(N[p]||0)&&l--,O<0)b.push(1),h=!0;else{for(C=N.length,F=T.length,p=0,O+=2,d=v(u/(T[0]+1)),d>1&&(T=t(T,d,u),N=t(N,d,u),F=T.length,C=N.length),S=F,_=N.slice(0,F),w=_.length;w<F;_[w++]=0);I=T.slice(),I.unshift(0),A=T[0],T[1]>=u/2&&A++;do{if(d=0,f=n(T,_,F,w),f<0){if(x=_[0],F!=w&&(x=x*u+(_[1]||0)),d=v(x/A),d>1)for(d>=u&&(d=u-1),m=t(T,d,u),y=m.length,w=_.length;1==n(m,_,y,w);)d--,r(m,F<y?I:T,y,u),y=m.length,f=1;else 0==d&&(f=d=1),m=T.slice(),y=m.length;if(y<w&&m.unshift(0),r(_,m,w,u),w=_.length,f==-1)for(;n(T,_,F,w)<1;)d++,r(_,F<w?I:T,w,u),w=_.length}else 0===f&&(d++,_=[0]);b[p++]=d,_[0]?_[w++]=N[S]||0:(_=[N[S]],w=1)}while((S++<C||null!=_[0])&&O--);h=null!=_[0],b[0]||b.shift()}if(u==k){for(p=1,O=b[0];O>=10;O/=10,p++);D(g,s+(g.e=p+l*B-1)+1,c,h)}else g.e=l,g.r=+h;return g}}(),m=function(){var t=/^(-?)0([xbo])/i,n=/^([^.]+)\.$/,r=/^\.([^.]+)$/,o=/^-?(Infinity|NaN)$/,i=/^\s*\+|^\s+|\s+$/g;return function(a,s,c,u){var f,l=c?s:s.replace(i,"");if(o.test(l))a.s=isNaN(l)?null:l<0?-1:1;else{if(!c&&(l=l.replace(t,function(t,e,n){return f="x"==(n=n.toLowerCase())?16:"b"==n?2:8,u&&u!=f?t:e}),u&&(f=u,l=l.replace(n,"$1").replace(r,"0.$1")),s!=l))return new e(l,f);W&&T(P,"not a"+(u?" base "+u:"")+" number",s),a.s=null}a.c=a.e=null,P=0}}(),R.absoluteValue=R.abs=function(){var t=new e(this);return t.s<0&&(t.s=1),t},R.ceil=function(){return D(new e(this),this.e+1,2)},R.comparedTo=R.cmp=function(t,n){return P=1,a(this,new e(t,n))},R.decimalPlaces=R.dp=function(){var t,e,n=this.c;if(!n)return null;if(t=((e=n.length-1)-o(this.e/B))*B,e=n[e])for(;e%10==0;e/=10,t--);return t<0&&(t=0),t},R.dividedBy=R.div=function(t,n){return P=3,E(this,new e(t,n),H,j)},R.dividedToIntegerBy=R.divToInt=function(t,n){return P=4,E(this,new e(t,n),0,1)},R.equals=R.eq=function(t,n){return P=5,0===a(this,new e(t,n))},R.floor=function(){return D(new e(this),this.e+1,3)},R.greaterThan=R.gt=function(t,n){return P=6,a(this,new e(t,n))>0},R.greaterThanOrEqualTo=R.gte=function(t,n){return P=7,1===(n=a(this,new e(t,n)))||0===n},R.isFinite=function(){return!!this.c},R.isInteger=R.isInt=function(){return!!this.c&&o(this.e/B)>this.c.length-2},R.isNaN=function(){return!this.s},R.isNegative=R.isNeg=function(){return this.s<0},R.isZero=function(){return!!this.c&&0==this.c[0]},R.lessThan=R.lt=function(t,n){return P=8,a(this,new e(t,n))<0},R.lessThanOrEqualTo=R.lte=function(t,n){return P=9,(n=a(this,new e(t,n)))===-1||0===n},R.minus=R.sub=function(t,n){var r,i,a,s,c=this,u=c.s;if(P=10,t=new e(t,n),n=t.s,!u||!n)return new e(NaN);if(u!=n)return t.s=-n,c.plus(t);var f=c.e/B,l=t.e/B,p=c.c,h=t.c;if(!f||!l){if(!p||!h)return p?(t.s=-n,t):new e(h?c:NaN);if(!p[0]||!h[0])return h[0]?(t.s=-n,t):new e(p[0]?c:3==j?-0:0)}if(f=o(f),l=o(l),p=p.slice(),u=f-l){for((s=u<0)?(u=-u,a=p):(l=f,a=h),a.reverse(),n=u;n--;a.push(0));a.reverse()}else for(i=(s=(u=p.length)<(n=h.length))?u:n,u=n=0;n<i;n++)if(p[n]!=h[n]){s=p[n]<h[n];break}if(s&&(a=p,p=h,h=a,t.s=-t.s),n=(i=h.length)-(r=p.length),n>0)for(;n--;p[r++]=0);for(n=k-1;i>u;){if(p[--i]<h[i]){for(r=i;r&&!p[--r];p[r]=n);--p[r],p[i]+=k}p[i]-=h[i]}for(;0==p[0];p.shift(),--l);return p[0]?N(t,p,l):(t.s=3==j?-1:1,t.c=[t.e=0],t)},R.modulo=R.mod=function(t,n){var r,o,i=this;return P=11,t=new e(t,n),!i.c||!t.s||t.c&&!t.c[0]?new e(NaN):!t.c||i.c&&!i.c[0]?new e(i):(9==X?(o=t.s,t.s=1,r=E(i,t,0,3),t.s=o,r.s*=o):r=E(i,t,0,X),i.minus(r.times(t)))},R.negated=R.neg=function(){var t=new e(this);return t.s=-t.s||null,t},R.plus=R.add=function(t,n){var r,i=this,a=i.s;if(P=12,t=new e(t,n),n=t.s,!a||!n)return new e(NaN);if(a!=n)return t.s=-n,i.minus(t);var s=i.e/B,c=t.e/B,u=i.c,f=t.c;if(!s||!c){if(!u||!f)return new e(a/0);if(!u[0]||!f[0])return f[0]?t:new e(u[0]?i:0*a)}if(s=o(s),c=o(c),u=u.slice(),a=s-c){for(a>0?(c=s,r=f):(a=-a,r=u),r.reverse();a--;r.push(0));r.reverse()}for(a=u.length,n=f.length,a-n<0&&(r=f,f=u,u=r,n=a),a=0;n;)a=(u[--n]=u[n]+f[n]+a)/k|0,u[n]%=k;return a&&(u.unshift(a),++c),N(t,u,c)},R.precision=R.sd=function(t){var e,n,r=this,o=r.c;if(null!=t&&t!==!!t&&1!==t&&0!==t&&(W&&T(13,"argument"+b,t),t!=!!t&&(t=null)),!o)return null;if(n=o.length-1,e=n*B+1,n=o[n]){for(;n%10==0;n/=10,e--);for(n=o[0];n>=10;n/=10,e++);}return t&&r.e+1>e&&(e=r.e+1),e},R.round=function(t,n){var r=new e(this);return(null==t||J(t,0,F,15))&&D(r,~~t+this.e+1,null!=n&&J(n,0,8,15,_)?0|n:j),r},R.shift=function(t){var n=this;return J(t,-S,S,16,"argument")?n.times("1e"+p(t)):new e(n.c&&n.c[0]&&(t<-S||t>S)?n.s*(t<0?0:1/0):n)},R.squareRoot=R.sqrt=function(){var t,n,r,a,s,c=this,u=c.c,f=c.s,l=c.e,p=H+4,h=new e("0.5");if(1!==f||!u||!u[0])return new e(!f||f<0&&(!u||u[0])?NaN:u?c:1/0);if(f=Math.sqrt(+c),0==f||f==1/0?(n=i(u),(n.length+l)%2==0&&(n+="0"),f=Math.sqrt(n),l=o((l+1)/2)-(l<0||l%2),f==1/0?n="1e"+l:(n=f.toExponential(),n=n.slice(0,n.indexOf("e")+1)+l),r=new e(n)):r=new e(f+""),r.c[0])for(l=r.e,f=l+p,f<3&&(f=0);;)if(s=r,r=h.times(s.plus(E(c,s,p,1))),i(s.c).slice(0,f)===(n=i(r.c)).slice(0,f)){if(r.e<l&&--f,n=n.slice(f-3,f+1),"9999"!=n&&(a||"4999"!=n)){+n&&(+n.slice(1)||"5"!=n.charAt(0))||(D(r,r.e+H+2,1),t=!r.times(r).eq(c));break}if(!a&&(D(s,s.e+H+2,0),s.times(s).eq(c))){r=s;break}p+=4,f+=4,a=1}return D(r,r.e+H+1,j,t)},R.times=R.mul=function(t,n){var r,i,a,s,c,u,f,l,p,h,d,m,y,g,v,b=this,_=b.c,w=(P=17,t=new e(t,n)).c;if(!(_&&w&&_[0]&&w[0]))return!b.s||!t.s||_&&!_[0]&&!w||w&&!w[0]&&!_?t.c=t.e=t.s=null:(t.s*=b.s,_&&w?(t.c=[0],t.e=0):t.c=t.e=null),t;for(i=o(b.e/B)+o(t.e/B),t.s*=b.s,f=_.length,h=w.length,f<h&&(y=_,_=w,w=y,a=f,f=h,h=a),a=f+h,y=[];a--;y.push(0));for(g=k,v=A,a=h;--a>=0;){for(r=0,d=w[a]%v,m=w[a]/v|0,c=f,s=a+c;s>a;)l=_[--c]%v,p=_[c]/v|0,u=m*l+p*d,l=d*l+u%v*v+y[s]+r,r=(l/g|0)+(u/v|0)+m*p,y[s--]=l%g;y[s]=r}return r?++i:y.shift(),N(t,y,i)},R.toDigits=function(t,n){var r=new e(this);return t=null!=t&&J(t,1,F,18,"precision")?0|t:null,n=null!=n&&J(n,0,8,18,_)?0|n:j,t?D(r,t,n):r},R.toExponential=function(t,e){return h(this,null!=t&&J(t,0,F,19)?~~t+1:null,e,19)},R.toFixed=function(t,e){return h(this,null!=t&&J(t,0,F,20)?~~t+this.e+1:null,e,20)},R.toFormat=function(t,e){var n=h(this,null!=t&&J(t,0,F,21)?~~t+this.e+1:null,e,21);if(this.c){var r,o=n.split("."),i=+V.groupSize,a=+V.secondaryGroupSize,s=V.groupSeparator,c=o[0],u=o[1],f=this.s<0,l=f?c.slice(1):c,p=l.length;if(a&&(r=i,i=a,a=r,p-=r),i>0&&p>0){for(r=p%i||i,c=l.substr(0,r);r<p;r+=i)c+=s+l.substr(r,i);a>0&&(c+=s+l.slice(r)),f&&(c="-"+c)}n=u?c+V.decimalSeparator+((a=+V.fractionGroupSize)?u.replace(new RegExp("\\d{"+a+"}\\B","g"),"$&"+V.fractionGroupSeparator):u):c}return n},R.toFraction=function(t){var n,r,o,a,s,c,u,f,l,p=W,h=this,d=h.c,m=new e(M),y=r=new e(M),g=u=new e(M);if(null!=t&&(W=!1,c=new e(t),W=p,(p=c.isInt())&&!c.lt(M)||(W&&T(22,"max denominator "+(p?"out of range":"not an integer"),t),t=!p&&c.c&&D(c,c.e+1,1).gte(M)?c:null)),!d)return h.toString();for(l=i(d),a=m.e=l.length-h.e-1,m.c[0]=C[(s=a%B)<0?B+s:s],t=!t||c.cmp(m)>0?a>0?m:y:c,s=U,U=1/0,c=new e(l),u.c[0]=0;f=E(c,m,0,1),o=r.plus(f.times(g)),1!=o.cmp(t);)r=g,g=o,y=u.plus(f.times(o=y)),u=o,m=c.minus(f.times(o=m)),c=o;return o=E(t.minus(r),g,0,1),u=u.plus(o.times(y)),r=r.plus(o.times(g)),u.s=y.s=h.s,a*=2,n=E(y,g,a,j).minus(h).abs().cmp(E(u,r,a,j).minus(h).abs())<1?[y.toString(),g.toString()]:[u.toString(),r.toString()],U=s,n},R.toNumber=function(){var t=this;return+t||(t.s?0*t.s:NaN)},R.toPower=R.pow=function(t){var n,r,o=v(t<0?-t:+t),i=this;if(!J(t,-S,S,23,"exponent")&&(!isFinite(t)||o>S&&(t/=0)||parseFloat(t)!=t&&!(t=NaN)))return new e(Math.pow(+i,t));for(n=$?g($/B+2):0,r=new e(M);;){if(o%2){if(r=r.times(i),!r.c)break;n&&r.c.length>n&&(r.c.length=n)}if(o=v(o/2),!o)break;i=i.times(i),n&&i.c&&i.c.length>n&&(i.c.length=n)}return t<0&&(r=M.div(r)),n?D(r,$,j):r},R.toPrecision=function(t,e){return h(this,null!=t&&J(t,1,F,24,"precision")?0|t:null,e,24)},R.toString=function(t){var e,r=this,o=r.s,a=r.e;return null===a?o?(e="Infinity",o<0&&(e="-"+e)):e="NaN":(e=i(r.c),e=null!=t&&J(t,2,64,25,"base")?n(l(e,a),0|t,10,o):a<=q||a>=z?f(e,a):l(e,a),o<0&&r.c[0]&&(e="-"+e)),e},R.truncated=R.trunc=function(){return D(new e(this),this.e+1,1)},R.valueOf=R.toJSON=function(){return this.toString()},null!=t&&e.config(t),e}function o(t){var e=0|t;return t>0||t===e?e:e-1}function i(t){for(var e,n,r=1,o=t.length,i=t[0]+"";r<o;){for(e=t[r++]+"",n=B-e.length;n--;e="0"+e);i+=e}for(o=i.length;48===i.charCodeAt(--o););return i.slice(0,o+1||1)}function a(t,e){var n,r,o=t.c,i=e.c,a=t.s,s=e.s,c=t.e,u=e.e;if(!a||!s)return null;if(n=o&&!o[0],r=i&&!i[0],n||r)return n?r?0:-s:a;if(a!=s)return a;if(n=a<0,r=c==u,!o||!i)return r?0:!o^n?1:-1;if(!r)return c>u^n?1:-1;for(s=(c=o.length)<(u=i.length)?c:u,a=0;a<s;a++)if(o[a]!=i[a])return o[a]>i[a]^n?1:-1;return c==u?0:c>u^n?1:-1}function s(t,e,n){return(t=p(t))>=e&&t<=n}function c(t){return"[object Array]"==Object.prototype.toString.call(t)}function u(t,e,n){for(var r,o,i=[0],a=0,s=t.length;a<s;){for(o=i.length;o--;i[o]*=e);for(i[r=0]+=x.indexOf(t.charAt(a++));r<i.length;r++)i[r]>n-1&&(null==i[r+1]&&(i[r+1]=0),i[r+1]+=i[r]/n|0,i[r]%=n)}return i.reverse()}function f(t,e){return(t.length>1?t.charAt(0)+"."+t.slice(1):t)+(e<0?"e":"e+")+e}function l(t,e){var n,r;if(e<0){for(r="0.";++e;r+="0");t=r+t}else if(n=t.length,++e>n){for(r="0",e-=n;--e;r+="0");t+=r}else e<n&&(t=t.slice(0,e)+"."+t.slice(e));return t}function p(t){return t=parseFloat(t),t<0?g(t):v(t)}var h,d,m,y=/^-?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i,g=Math.ceil,v=Math.floor,b=" not a boolean or binary digit",_="rounding mode",w="number type has more than 15 significant digits",x="0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ$_",k=1e14,B=14,S=9007199254740991,C=[1,10,100,1e3,1e4,1e5,1e6,1e7,1e8,1e9,1e10,1e11,1e12,1e13],A=1e7,F=1e9;if(h=r(),"function"==typeof define&&define.amd)define(function(){return h});else if("undefined"!=typeof e&&e.exports){if(e.exports=h,!d)try{d=t("crypto")}catch(t){}}else n.BigNumber=h}(this)},{crypto:50}],web3:[function(t,e,n){var r=t("./lib/web3");"undefined"!=typeof window&&"undefined"==typeof window.Web3&&(window.Web3=r),e.exports=r},{"./lib/web3":22}]},{},["web3"]);
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/wrappy/wrappy.js":[function(_dereq_,module,exports){
// Returns a wrapper function that returns a wrapped callback
// The wrapper function should do some stuff, and return a
// presumably different callback function.
// This makes sure that own properties are retained, so that
// decorations and such are not lost along the way.
module.exports = wrappy
function wrappy (fn, cb) {
  if (fn && cb) return wrappy(fn)(cb)

  if (typeof fn !== 'function')
    throw new TypeError('need wrapper function')

  Object.keys(fn).forEach(function (k) {
    wrapper[k] = fn[k]
  })

  return wrapper

  function wrapper() {
    var args = new Array(arguments.length)
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i]
    }
    var ret = fn.apply(this, args)
    var cb = args[args.length-1]
    if (typeof ret === 'function' && ret !== cb) {
      Object.keys(cb).forEach(function (k) {
        ret[k] = cb[k]
      })
    }
    return ret
  }
}

},{}],"/Users/jorge/provident/aragon/.metamask/node_modules/xtend/immutable.js":[function(_dereq_,module,exports){
module.exports = extend

var hasOwnProperty = Object.prototype.hasOwnProperty;

function extend() {
    var target = {}

    for (var i = 0; i < arguments.length; i++) {
        var source = arguments[i]

        for (var key in source) {
            if (hasOwnProperty.call(source, key)) {
                target[key] = source[key]
            }
        }
    }

    return target
}

},{}]},{},["/Users/jorge/provident/aragon/.metamask/app/scripts/inpage.js"])

//# sourceMappingURL=inpage.js.map
