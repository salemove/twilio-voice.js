"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * @packageDocumentation
 * @module Voice
 * @internalapi
 */
// @ts-nocheck
var errors_1 = require("../errors");
var log_1 = require("../log");
var util = require("../util");
var rtcpc_1 = require("./rtcpc");
var sdp_1 = require("./sdp");
var ICE_GATHERING_TIMEOUT = 15000;
var ICE_GATHERING_FAIL_NONE = 'none';
var ICE_GATHERING_FAIL_TIMEOUT = 'timeout';
var INITIAL_ICE_CONNECTION_STATE = 'new';
var VOLUME_INTERVAL_MS = 50;
/**
 * @typedef {Object} PeerConnection
 * @param audioHelper
 * @param pstream
 * @param options
 * @return {PeerConnection}
 * @constructor
 */
function PeerConnection(audioHelper, pstream, getUserMedia, options) {
    if (!audioHelper || !pstream || !getUserMedia) {
        throw new errors_1.InvalidArgumentError('Audiohelper, pstream and getUserMedia are required arguments');
    }
    if (!(this instanceof PeerConnection)) {
        return new PeerConnection(audioHelper, pstream, getUserMedia, options);
    }
    this._log = log_1.default.getInstance();
    function noop() {
        this._log.warn('Unexpected noop call in peerconnection');
    }
    this.onaudio = noop;
    this.onopen = noop;
    this.onerror = noop;
    this.onclose = noop;
    this.ondisconnected = noop;
    this.onfailed = noop;
    this.onconnected = noop;
    this.onreconnected = noop;
    this.onsignalingstatechange = noop;
    this.ondtlstransportstatechange = noop;
    this.onicegatheringfailure = noop;
    this.onicegatheringstatechange = noop;
    this.oniceconnectionstatechange = noop;
    this.onpcconnectionstatechange = noop;
    this.onicecandidate = noop;
    this.onselectedcandidatepairchange = noop;
    this.onvolume = noop;
    this.version = null;
    this.pstream = pstream;
    this.stream = null;
    this.sinkIds = new Set(['default']);
    this.outputs = new Map();
    this.status = 'connecting';
    this.callSid = null;
    this.isMuted = false;
    this.getUserMedia = getUserMedia;
    var AudioContext = typeof window !== 'undefined'
        && (window.AudioContext || window.webkitAudioContext);
    this._isSinkSupported = !!AudioContext &&
        typeof HTMLAudioElement !== 'undefined' && HTMLAudioElement.prototype.setSinkId;
    // NOTE(mmalavalli): Since each Connection creates its own AudioContext,
    // after 6 instances an exception is thrown. Refer https://www.w3.org/2011/audio/track/issues/3.
    // In order to get around it, we are re-using the Device's AudioContext.
    this._audioContext = AudioContext && audioHelper._audioContext;
    this._hasIceCandidates = false;
    this._hasIceGatheringFailures = false;
    this._iceGatheringTimeoutId = null;
    this._masterAudio = null;
    this._masterAudioDeviceId = null;
    this._mediaStreamSource = null;
    this._dtmfSender = null;
    this._dtmfSenderUnsupported = false;
    this._callEvents = [];
    this._nextTimeToPublish = Date.now();
    this._onAnswerOrRinging = noop;
    this._onHangup = noop;
    this._remoteStream = null;
    this._shouldManageStream = true;
    this._iceState = INITIAL_ICE_CONNECTION_STATE;
    this._isUnifiedPlan = options.isUnifiedPlan;
    this.options = options = options || {};
    this.navigator = options.navigator
        || (typeof navigator !== 'undefined' ? navigator : null);
    this.util = options.util || util;
    this.codecPreferences = options.codecPreferences;
    return this;
}
PeerConnection.prototype.uri = function () {
    return this._uri;
};
/**
 * Open the underlying RTCPeerConnection with a MediaStream obtained by
 *   passed constraints. The resulting MediaStream is created internally
 *   and will therefore be managed and destroyed internally.
 * @param {MediaStreamConstraints} constraints
 */
PeerConnection.prototype.openWithConstraints = function (constraints) {
    return this.getUserMedia({ audio: constraints })
        .then(this._setInputTracksFromStream.bind(this, false));
};
/**
 * Replace the existing input audio tracks with the audio tracks from the
 *   passed input audio stream. We re-use the existing stream because
 *   the AnalyzerNode is bound to the stream.
 * @param {MediaStream} stream
 */
PeerConnection.prototype.setInputTracksFromStream = function (stream) {
    var self = this;
    return this._setInputTracksFromStream(true, stream).then(function () {
        self._shouldManageStream = false;
    });
};
PeerConnection.prototype._createAnalyser = function (audioContext, options) {
    options = Object.assign({
        fftSize: 32,
        smoothingTimeConstant: 0.3,
    }, options);
    var analyser = audioContext.createAnalyser();
    // tslint:disable-next-line
    for (var field in options) {
        analyser[field] = options[field];
    }
    return analyser;
};
PeerConnection.prototype._setVolumeHandler = function (handler) {
    this.onvolume = handler;
};
PeerConnection.prototype._startPollingVolume = function () {
    if (!this._audioContext || !this.stream || !this._remoteStream) {
        return;
    }
    var audioContext = this._audioContext;
    var inputAnalyser = this._inputAnalyser = this._createAnalyser(audioContext);
    var inputBufferLength = inputAnalyser.frequencyBinCount;
    var inputDataArray = new Uint8Array(inputBufferLength);
    this._inputAnalyser2 = this._createAnalyser(audioContext, {
        maxDecibels: 0,
        minDecibels: -127,
        smoothingTimeConstant: 0,
    });
    var outputAnalyser = this._outputAnalyser = this._createAnalyser(audioContext);
    var outputBufferLength = outputAnalyser.frequencyBinCount;
    var outputDataArray = new Uint8Array(outputBufferLength);
    this._outputAnalyser2 = this._createAnalyser(audioContext, {
        maxDecibels: 0,
        minDecibels: -127,
        smoothingTimeConstant: 0,
    });
    this._updateInputStreamSource(this.stream);
    this._updateOutputStreamSource(this._remoteStream);
    var self = this;
    setTimeout(function emitVolume() {
        if (!self._audioContext) {
            return;
        }
        else if (self.status === 'closed') {
            self._inputAnalyser.disconnect();
            self._outputAnalyser.disconnect();
            self._inputAnalyser2.disconnect();
            self._outputAnalyser2.disconnect();
            return;
        }
        self._inputAnalyser.getByteFrequencyData(inputDataArray);
        var inputVolume = self.util.average(inputDataArray);
        self._inputAnalyser2.getByteFrequencyData(inputDataArray);
        var inputVolume2 = self.util.average(inputDataArray);
        self._outputAnalyser.getByteFrequencyData(outputDataArray);
        var outputVolume = self.util.average(outputDataArray);
        self._outputAnalyser2.getByteFrequencyData(outputDataArray);
        var outputVolume2 = self.util.average(outputDataArray);
        self.onvolume(inputVolume / 255, outputVolume / 255, inputVolume2, outputVolume2);
        setTimeout(emitVolume, VOLUME_INTERVAL_MS);
    }, VOLUME_INTERVAL_MS);
};
PeerConnection.prototype._stopStream = function _stopStream(stream) {
    // We shouldn't stop the tracks if they were not created inside
    //   this PeerConnection.
    if (!this._shouldManageStream) {
        return;
    }
    if (typeof MediaStreamTrack.prototype.stop === 'function') {
        var audioTracks = typeof stream.getAudioTracks === 'function'
            ? stream.getAudioTracks() : stream.audioTracks;
        audioTracks.forEach(function (track) {
            track.stop();
        });
    }
    else {
        // NOTE(mroberts): This is just a fallback to any ancient browsers that may
        // not implement MediaStreamTrack.stop.
        stream.stop();
    }
};
/**
 * Update the stream source with the new input audio stream.
 * @param {MediaStream} stream
 * @private
 */
PeerConnection.prototype._updateInputStreamSource = function (stream) {
    if (this._inputStreamSource) {
        this._inputStreamSource.disconnect();
    }
    try {
        this._inputStreamSource = this._audioContext.createMediaStreamSource(stream);
        this._inputStreamSource.connect(this._inputAnalyser);
        this._inputStreamSource.connect(this._inputAnalyser2);
    }
    catch (ex) {
        this._log.warn('Unable to update input MediaStreamSource', ex);
        this._inputStreamSource = null;
    }
};
/**
 * Update the stream source with the new ouput audio stream.
 * @param {MediaStream} stream
 * @private
 */
PeerConnection.prototype._updateOutputStreamSource = function (stream) {
    if (this._outputStreamSource) {
        this._outputStreamSource.disconnect();
    }
    try {
        this._outputStreamSource = this._audioContext.createMediaStreamSource(stream);
        this._outputStreamSource.connect(this._outputAnalyser);
        this._outputStreamSource.connect(this._outputAnalyser2);
    }
    catch (ex) {
        this._log.warn('Unable to update output MediaStreamSource', ex);
        this._outputStreamSource = null;
    }
};
/**
 * Replace the tracks of the current stream with new tracks. We do this rather than replacing the
 *   whole stream because AnalyzerNodes are bound to a stream.
 * @param {Boolean} shouldClone - Whether the stream should be cloned if it is the first
 *   stream, or set directly. As a rule of thumb, streams that are passed in externally may have
 *   their lifecycle managed externally, and should be cloned so that we do not tear it or its tracks
 *   down when the call ends. Streams that we create internally (inside PeerConnection) should be set
 *   directly so that when the call ends it is disposed of.
 * @param {MediaStream} newStream - The new stream to copy the tracks over from.
 * @private
 */
PeerConnection.prototype._setInputTracksFromStream = function (shouldClone, newStream) {
    return this._isUnifiedPlan
        ? this._setInputTracksForUnifiedPlan(shouldClone, newStream)
        : this._setInputTracksForPlanB(shouldClone, newStream);
};
/**
 * Replace the tracks of the current stream with new tracks using the 'plan-b' method.
 * @param {Boolean} shouldClone - Whether the stream should be cloned if it is the first
 *   stream, or set directly. As a rule of thumb, streams that are passed in externally may have
 *   their lifecycle managed externally, and should be cloned so that we do not tear it or its tracks
 *   down when the call ends. Streams that we create internally (inside PeerConnection) should be set
 *   directly so that when the call ends it is disposed of.
 * @param {MediaStream} newStream - The new stream to copy the tracks over from.
 * @private
 */
PeerConnection.prototype._setInputTracksForPlanB = function (shouldClone, newStream) {
    var _this = this;
    if (!newStream) {
        return Promise.reject(new errors_1.InvalidArgumentError('Can not set input stream to null while in a call'));
    }
    if (!newStream.getAudioTracks().length) {
        return Promise.reject(new errors_1.InvalidArgumentError('Supplied input stream has no audio tracks'));
    }
    var localStream = this.stream;
    if (!localStream) {
        // We can't use MediaStream.clone() here because it stopped copying over tracks
        //   as of Chrome 61. https://bugs.chromium.org/p/chromium/issues/detail?id=770908
        this.stream = shouldClone ? cloneStream(newStream) : newStream;
    }
    else {
        this._stopStream(localStream);
        removeStream(this.version.pc, localStream);
        localStream.getAudioTracks().forEach(localStream.removeTrack, localStream);
        newStream.getAudioTracks().forEach(localStream.addTrack, localStream);
        addStream(this.version.pc, newStream);
        this._updateInputStreamSource(this.stream);
    }
    // Apply mute settings to new input track
    this.mute(this.isMuted);
    if (!this.version) {
        return Promise.resolve(this.stream);
    }
    return new Promise(function (resolve, reject) {
        _this.version.createOffer(_this.options.maxAverageBitrate, _this.codecPreferences, { audio: true }, function () {
            _this.version.processAnswer(_this.codecPreferences, _this._answerSdp, function () {
                resolve(_this.stream);
            }, reject);
        }, reject);
    });
};
/**
 * Replace the tracks of the current stream with new tracks using the 'unified-plan' method.
 * @param {Boolean} shouldClone - Whether the stream should be cloned if it is the first
 *   stream, or set directly. As a rule of thumb, streams that are passed in externally may have
 *   their lifecycle managed externally, and should be cloned so that we do not tear it or its tracks
 *   down when the call ends. Streams that we create internally (inside PeerConnection) should be set
 *   directly so that when the call ends it is disposed of.
 * @param {MediaStream} newStream - The new stream to copy the tracks over from.
 * @private
 */
PeerConnection.prototype._setInputTracksForUnifiedPlan = function (shouldClone, newStream) {
    var _this = this;
    if (!newStream) {
        return Promise.reject(new errors_1.InvalidArgumentError('Can not set input stream to null while in a call'));
    }
    if (!newStream.getAudioTracks().length) {
        return Promise.reject(new errors_1.InvalidArgumentError('Supplied input stream has no audio tracks'));
    }
    var localStream = this.stream;
    var getStreamPromise = function () {
        // Apply mute settings to new input track
        _this.mute(_this.isMuted);
        return Promise.resolve(_this.stream);
    };
    if (!localStream) {
        // We can't use MediaStream.clone() here because it stopped copying over tracks
        //   as of Chrome 61. https://bugs.chromium.org/p/chromium/issues/detail?id=770908
        this.stream = shouldClone ? cloneStream(newStream) : newStream;
    }
    else {
        // If the call was started with gUM, and we are now replacing that track with an
        // external stream's tracks, we should stop the old managed track.
        if (this._shouldManageStream) {
            this._stopStream(localStream);
        }
        if (!this._sender) {
            this._sender = this.version.pc.getSenders()[0];
        }
        return this._sender.replaceTrack(newStream.getAudioTracks()[0]).then(function () {
            _this._updateInputStreamSource(newStream);
            return getStreamPromise();
        });
    }
    return getStreamPromise();
};
PeerConnection.prototype._onInputDevicesChanged = function () {
    if (!this.stream) {
        return;
    }
    // If all of our active tracks are ended, then our active input was lost
    var activeInputWasLost = this.stream.getAudioTracks().every(function (track) { return track.readyState === 'ended'; });
    // We only want to act if we manage the stream in PeerConnection (It was created
    // here, rather than passed in.)
    if (activeInputWasLost && this._shouldManageStream) {
        this.openWithConstraints(true);
    }
};
PeerConnection.prototype._onIceGatheringFailure = function (type) {
    this._hasIceGatheringFailures = true;
    this.onicegatheringfailure(type);
};
PeerConnection.prototype._onMediaConnectionStateChange = function (newState) {
    var previousState = this._iceState;
    if (previousState === newState
        || (newState !== 'connected'
            && newState !== 'disconnected'
            && newState !== 'failed')) {
        return;
    }
    this._iceState = newState;
    var message;
    switch (newState) {
        case 'connected':
            if (previousState === 'disconnected' || previousState === 'failed') {
                message = 'ICE liveliness check succeeded. Connection with Twilio restored';
                this._log.info(message);
                this.onreconnected(message);
            }
            else {
                message = 'Media connection established.';
                this._log.info(message);
                this.onconnected(message);
            }
            this._stopIceGatheringTimeout();
            this._hasIceGatheringFailures = false;
            break;
        case 'disconnected':
            message = 'ICE liveliness check failed. May be having trouble connecting to Twilio';
            this._log.info(message);
            this.ondisconnected(message);
            break;
        case 'failed':
            message = 'Connection with Twilio was interrupted.';
            this._log.info(message);
            this.onfailed(message);
            break;
    }
};
PeerConnection.prototype._setSinkIds = function (sinkIds) {
    if (!this._isSinkSupported) {
        return Promise.reject(new errors_1.NotSupportedError('Audio output selection is not supported by this browser'));
    }
    this.sinkIds = new Set(sinkIds.forEach ? sinkIds : [sinkIds]);
    return this.version
        ? this._updateAudioOutputs()
        : Promise.resolve();
};
/**
 * Start timeout for ICE Gathering
 */
PeerConnection.prototype._startIceGatheringTimeout = function startIceGatheringTimeout() {
    var _this = this;
    this._stopIceGatheringTimeout();
    this._iceGatheringTimeoutId = setTimeout(function () {
        _this._onIceGatheringFailure(ICE_GATHERING_FAIL_TIMEOUT);
    }, ICE_GATHERING_TIMEOUT);
};
/**
 * Stop timeout for ICE Gathering
 */
PeerConnection.prototype._stopIceGatheringTimeout = function stopIceGatheringTimeout() {
    clearInterval(this._iceGatheringTimeoutId);
};
PeerConnection.prototype._updateAudioOutputs = function updateAudioOutputs() {
    var addedOutputIds = Array.from(this.sinkIds).filter(function (id) {
        return !this.outputs.has(id);
    }, this);
    var removedOutputIds = Array.from(this.outputs.keys()).filter(function (id) {
        return !this.sinkIds.has(id);
    }, this);
    var self = this;
    var createOutputPromises = addedOutputIds.map(this._createAudioOutput, this);
    return Promise.all(createOutputPromises).then(function () { return Promise.all(removedOutputIds.map(self._removeAudioOutput, self)); });
};
PeerConnection.prototype._createAudio = function createAudio(arr) {
    var audio = new Audio(arr);
    this.onaudio(audio);
    return audio;
};
PeerConnection.prototype._createAudioOutput = function createAudioOutput(id) {
    var dest = null;
    if (this._mediaStreamSource) {
        dest = this._audioContext.createMediaStreamDestination();
        this._mediaStreamSource.connect(dest);
    }
    var audio = this._createAudio();
    setAudioSource(audio, dest && dest.stream ? dest.stream : this.pcStream);
    var self = this;
    return audio.setSinkId(id).then(function () { return audio.play(); }).then(function () {
        self.outputs.set(id, {
            audio: audio,
            dest: dest,
        });
    });
};
PeerConnection.prototype._removeAudioOutputs = function removeAudioOutputs() {
    if (this._masterAudio && typeof this._masterAudioDeviceId !== 'undefined') {
        this._disableOutput(this, this._masterAudioDeviceId);
        this.outputs.delete(this._masterAudioDeviceId);
        this._masterAudioDeviceId = null;
        // Release the audio resources before deleting the audio
        if (!this._masterAudio.paused) {
            this._masterAudio.pause();
        }
        if (typeof this._masterAudio.srcObject !== 'undefined') {
            this._masterAudio.srcObject = null;
        }
        else {
            this._masterAudio.src = '';
        }
        this._masterAudio = null;
    }
    return Array.from(this.outputs.keys()).map(this._removeAudioOutput, this);
};
PeerConnection.prototype._disableOutput = function disableOutput(pc, id) {
    var output = pc.outputs.get(id);
    if (!output) {
        return;
    }
    if (output.audio) {
        output.audio.pause();
        output.audio.src = '';
    }
    if (output.dest) {
        output.dest.disconnect();
    }
};
/**
 * Disable a non-master output, and update the master output to assume its state. This
 *   is called when the device ID assigned to the master output has been removed from
 *   active devices. We can not simply remove the master audio output, so we must
 *   instead reassign it.
 * @private
 * @param {PeerConnection} pc
 * @param {string} masterId - The current device ID assigned to the master audio element.
 */
PeerConnection.prototype._reassignMasterOutput = function reassignMasterOutput(pc, masterId) {
    var masterOutput = pc.outputs.get(masterId);
    pc.outputs.delete(masterId);
    var self = this;
    var firstEntry = Array.from(pc.outputs.keys())[0];
    var idToReplace = firstEntry !== null && firstEntry !== undefined ? firstEntry : 'default';
    return masterOutput.audio.setSinkId(idToReplace).then(function () {
        self._disableOutput(pc, idToReplace);
        pc.outputs.set(idToReplace, masterOutput);
        pc._masterAudioDeviceId = idToReplace;
    }).catch(function rollback() {
        pc.outputs.set(masterId, masterOutput);
        self._log.info('Could not reassign master output. Attempted to roll back.');
    });
};
PeerConnection.prototype._removeAudioOutput = function removeAudioOutput(id) {
    if (this._masterAudioDeviceId === id) {
        return this._reassignMasterOutput(this, id);
    }
    this._disableOutput(this, id);
    this.outputs.delete(id);
    return Promise.resolve();
};
/**
 * Use an AudioContext to potentially split our audio output stream to multiple
 *   audio devices. This is only available to browsers with AudioContext and
 *   HTMLAudioElement.setSinkId() available. We save the source stream in
 *   _masterAudio, and use it for one of the active audio devices. We keep
 *   track of its ID because we must replace it if we lose its initial device.
 */
PeerConnection.prototype._onAddTrack = function onAddTrack(pc, stream) {
    var audio = pc._masterAudio = this._createAudio();
    setAudioSource(audio, stream);
    audio.play();
    // Assign the initial master audio element to a random active output device
    var firstEntry = Array.from(pc.outputs.keys())[0];
    var deviceId = firstEntry !== null && firstEntry !== undefined ? firstEntry : 'default';
    pc._masterAudioDeviceId = deviceId;
    pc.outputs.set(deviceId, { audio: audio });
    try {
        pc._mediaStreamSource = pc._audioContext.createMediaStreamSource(stream);
    }
    catch (ex) {
        this._log.warn('Unable to create a MediaStreamSource from onAddTrack', ex);
        this._mediaStreamSource = null;
    }
    pc.pcStream = stream;
    pc._updateAudioOutputs();
};
/**
 * Use a single audio element to play the audio output stream. This does not
 *   support multiple output devices, and is a fallback for when AudioContext
 *   and/or HTMLAudioElement.setSinkId() is not available to the client.
 */
PeerConnection.prototype._fallbackOnAddTrack = function fallbackOnAddTrack(pc, stream) {
    var audio = document && document.createElement('audio');
    audio.autoplay = true;
    if (!setAudioSource(audio, stream)) {
        pc._log.info('Error attaching stream to element.');
    }
    pc.outputs.set('default', { audio: audio });
};
PeerConnection.prototype._setEncodingParameters = function (enableDscp) {
    if (!enableDscp
        || !this._sender
        || typeof this._sender.getParameters !== 'function'
        || typeof this._sender.setParameters !== 'function') {
        return;
    }
    var params = this._sender.getParameters();
    if (!params.priority && !(params.encodings && params.encodings.length)) {
        return;
    }
    // This is how MDN's RTPSenderParameters defines priority
    params.priority = 'high';
    // And this is how it's currently implemented in Chrome M72+
    if (params.encodings && params.encodings.length) {
        params.encodings.forEach(function (encoding) {
            encoding.priority = 'high';
            encoding.networkPriority = 'high';
        });
    }
    this._sender.setParameters(params);
};
PeerConnection.prototype._setupPeerConnection = function (rtcConstraints, rtcConfiguration) {
    var _this = this;
    var self = this;
    var version = new (this.options.rtcpcFactory || rtcpc_1.default)({ RTCPeerConnection: this.options.RTCPeerConnection });
    version.create(rtcConstraints, rtcConfiguration);
    addStream(version.pc, this.stream);
    var eventName = 'ontrack' in version.pc
        ? 'ontrack' : 'onaddstream';
    version.pc[eventName] = function (event) {
        var stream = self._remoteStream = event.stream || event.streams[0];
        if (typeof version.pc.getSenders === 'function') {
            _this._sender = version.pc.getSenders()[0];
        }
        if (self._isSinkSupported) {
            self._onAddTrack(self, stream);
        }
        else {
            self._fallbackOnAddTrack(self, stream);
        }
        self._startPollingVolume();
    };
    return version;
};
PeerConnection.prototype._maybeSetIceAggressiveNomination = function (sdp) {
    return this.options.forceAggressiveIceNomination ? sdp_1.setIceAggressiveNomination(sdp) : sdp;
};
PeerConnection.prototype._setupChannel = function () {
    var _this = this;
    var pc = this.version.pc;
    // Chrome 25 supports onopen
    this.version.pc.onopen = function () {
        _this.status = 'open';
        _this.onopen();
    };
    // Chrome 26 doesn't support onopen so must detect state change
    this.version.pc.onstatechange = function () {
        if (_this.version.pc && _this.version.pc.readyState === 'stable') {
            _this.status = 'open';
            _this.onopen();
        }
    };
    // Chrome 27 changed onstatechange to onsignalingstatechange
    this.version.pc.onsignalingstatechange = function () {
        var state = pc.signalingState;
        _this._log.info("signalingState is \"" + state + "\"");
        if (_this.version.pc && _this.version.pc.signalingState === 'stable') {
            _this.status = 'open';
            _this.onopen();
        }
        _this.onsignalingstatechange(pc.signalingState);
    };
    // Chrome 72+
    pc.onconnectionstatechange = function (event) {
        var state = pc.connectionState;
        if (!state && event && event.target) {
            // VDI environment
            var targetPc = event.target;
            state = targetPc.connectionState || targetPc.connectionState_;
            _this._log.info("pc.connectionState not detected. Using target PC. State=" + state);
        }
        if (!state) {
            _this._log.warn("onconnectionstatechange detected but state is \"" + state + "\"");
        }
        else {
            _this._log.info("pc.connectionState is \"" + state + "\"");
        }
        _this.onpcconnectionstatechange(state);
        _this._onMediaConnectionStateChange(state);
    };
    pc.onicecandidate = function (event) {
        var candidate = event.candidate;
        if (candidate) {
            _this._hasIceCandidates = true;
            _this.onicecandidate(candidate);
            _this._setupRTCIceTransportListener();
        }
        _this._log.info("ICE Candidate: " + JSON.stringify(candidate));
    };
    pc.onicegatheringstatechange = function () {
        var state = pc.iceGatheringState;
        if (state === 'gathering') {
            _this._startIceGatheringTimeout();
        }
        else if (state === 'complete') {
            _this._stopIceGatheringTimeout();
            // Fail if no candidates found
            if (!_this._hasIceCandidates) {
                _this._onIceGatheringFailure(ICE_GATHERING_FAIL_NONE);
            }
            // There was a failure mid-gathering phase. We want to start our timer and issue
            // an ice restart if we don't get connected after our timeout
            if (_this._hasIceCandidates && _this._hasIceGatheringFailures) {
                _this._startIceGatheringTimeout();
            }
        }
        _this._log.info("pc.iceGatheringState is \"" + pc.iceGatheringState + "\"");
        _this.onicegatheringstatechange(state);
    };
    pc.oniceconnectionstatechange = function () {
        _this._log.info("pc.iceConnectionState is \"" + pc.iceConnectionState + "\"");
        _this.oniceconnectionstatechange(pc.iceConnectionState);
        _this._onMediaConnectionStateChange(pc.iceConnectionState);
    };
};
PeerConnection.prototype._initializeMediaStream = function (rtcConstraints, rtcConfiguration) {
    // if mediastream already open then do nothing
    if (this.status === 'open') {
        return false;
    }
    if (this.pstream.status === 'disconnected') {
        this.onerror({ info: {
                code: 31000,
                message: 'Cannot establish connection. Client is disconnected',
                twilioError: new errors_1.SignalingErrors.ConnectionDisconnected(),
            } });
        this.close();
        return false;
    }
    this.version = this._setupPeerConnection(rtcConstraints, rtcConfiguration);
    this._setupChannel();
    return true;
};
/**
 * Remove reconnection-related listeners
 * @private
 */
PeerConnection.prototype._removeReconnectionListeners = function () {
    if (this.pstream) {
        this.pstream.removeListener('answer', this._onAnswerOrRinging);
        this.pstream.removeListener('hangup', this._onHangup);
    }
};
/**
 * Setup a listener for RTCDtlsTransport to capture state changes events
 * @private
 */
PeerConnection.prototype._setupRTCDtlsTransportListener = function () {
    var _this = this;
    var dtlsTransport = this.getRTCDtlsTransport();
    if (!dtlsTransport || dtlsTransport.onstatechange) {
        return;
    }
    var handler = function () {
        _this._log.info("dtlsTransportState is \"" + dtlsTransport.state + "\"");
        _this.ondtlstransportstatechange(dtlsTransport.state);
    };
    // Publish initial state
    handler();
    dtlsTransport.onstatechange = handler;
};
/**
 * Setup a listener for RTCIceTransport to capture selected candidate pair changes
 * @private
 */
PeerConnection.prototype._setupRTCIceTransportListener = function () {
    var _this = this;
    var iceTransport = this._getRTCIceTransport();
    if (!iceTransport || iceTransport.onselectedcandidatepairchange) {
        return;
    }
    iceTransport.onselectedcandidatepairchange = function () {
        return _this.onselectedcandidatepairchange(iceTransport.getSelectedCandidatePair());
    };
};
/**
 * Restarts ICE for the current connection
 * ICE Restart failures are ignored. Retries are managed in Connection
 * @private
 */
PeerConnection.prototype.iceRestart = function () {
    var _this = this;
    this._log.info('Attempting to restart ICE...');
    this._hasIceCandidates = false;
    this.version.createOffer(this.options.maxAverageBitrate, this.codecPreferences, { iceRestart: true }).then(function () {
        _this._removeReconnectionListeners();
        _this._onAnswerOrRinging = function (payload) {
            _this._removeReconnectionListeners();
            if (!payload.sdp || _this.version.pc.signalingState !== 'have-local-offer') {
                var message = 'Invalid state or param during ICE Restart:'
                    + ("hasSdp:" + !!payload.sdp + ", signalingState:" + _this.version.pc.signalingState);
                _this._log.info(message);
                return;
            }
            var sdp = _this._maybeSetIceAggressiveNomination(payload.sdp);
            _this._answerSdp = sdp;
            if (_this.status !== 'closed') {
                _this.version.processAnswer(_this.codecPreferences, sdp, null, function (err) {
                    var message = err && err.message ? err.message : err;
                    _this._log.info("Failed to process answer during ICE Restart. Error: " + message);
                });
            }
        };
        _this._onHangup = function () {
            _this._log.info('Received hangup during ICE Restart');
            _this._removeReconnectionListeners();
        };
        _this.pstream.on('answer', _this._onAnswerOrRinging);
        _this.pstream.on('hangup', _this._onHangup);
        _this.pstream.reinvite(_this.version.getSDP(), _this.callSid);
    }).catch(function (err) {
        var message = err && err.message ? err.message : err;
        _this._log.info("Failed to createOffer during ICE Restart. Error: " + message);
        // CreateOffer failures doesn't transition ice state to failed
        // We need trigger it so it can be picked up by retries
        _this.onfailed(message);
    });
};
PeerConnection.prototype.makeOutgoingCall = function (token, params, callsid, rtcConstraints, rtcConfiguration, onMediaStarted) {
    var _this = this;
    if (!this._initializeMediaStream(rtcConstraints, rtcConfiguration)) {
        return;
    }
    var self = this;
    this.callSid = callsid;
    function onAnswerSuccess() {
        if (self.options) {
            self._setEncodingParameters(self.options.dscp);
        }
        onMediaStarted(self.version.pc);
    }
    function onAnswerError(err) {
        var errMsg = err.message || err;
        self.onerror({ info: {
                code: 31000,
                message: "Error processing answer: " + errMsg,
                twilioError: new errors_1.MediaErrors.ClientRemoteDescFailed(),
            } });
    }
    this._onAnswerOrRinging = function (payload) {
        if (!payload.sdp) {
            return;
        }
        var sdp = _this._maybeSetIceAggressiveNomination(payload.sdp);
        self._answerSdp = sdp;
        if (self.status !== 'closed') {
            self.version.processAnswer(_this.codecPreferences, sdp, onAnswerSuccess, onAnswerError);
        }
        self.pstream.removeListener('answer', self._onAnswerOrRinging);
        self.pstream.removeListener('ringing', self._onAnswerOrRinging);
    };
    this.pstream.on('answer', this._onAnswerOrRinging);
    this.pstream.on('ringing', this._onAnswerOrRinging);
    function onOfferSuccess() {
        if (self.status !== 'closed') {
            self.pstream.invite(self.version.getSDP(), self.callSid, self.options.preflight, params);
            self._setupRTCDtlsTransportListener();
        }
    }
    function onOfferError(err) {
        var errMsg = err.message || err;
        self.onerror({ info: {
                code: 31000,
                message: "Error creating the offer: " + errMsg,
                twilioError: new errors_1.MediaErrors.ClientLocalDescFailed(),
            } });
    }
    this.version.createOffer(this.options.maxAverageBitrate, this.codecPreferences, { audio: true }, onOfferSuccess, onOfferError);
};
PeerConnection.prototype.answerIncomingCall = function (callSid, sdp, rtcConstraints, rtcConfiguration, onMediaStarted) {
    if (!this._initializeMediaStream(rtcConstraints, rtcConfiguration)) {
        return;
    }
    sdp = this._maybeSetIceAggressiveNomination(sdp);
    this._answerSdp = sdp.replace(/^a=setup:actpass$/gm, 'a=setup:passive');
    this.callSid = callSid;
    var self = this;
    function onAnswerSuccess() {
        if (self.status !== 'closed') {
            self.pstream.answer(self.version.getSDP(), callSid);
            if (self.options) {
                self._setEncodingParameters(self.options.dscp);
            }
            onMediaStarted(self.version.pc);
            self._setupRTCDtlsTransportListener();
        }
    }
    function onAnswerError(err) {
        var errMsg = err.message || err;
        self.onerror({ info: {
                code: 31000,
                message: "Error creating the answer: " + errMsg,
                twilioError: new errors_1.MediaErrors.ClientRemoteDescFailed(),
            } });
    }
    this.version.processSDP(this.options.maxAverageBitrate, this.codecPreferences, sdp, { audio: true }, onAnswerSuccess, onAnswerError);
};
PeerConnection.prototype.close = function () {
    if (this.version && this.version.pc) {
        if (this.version.pc.signalingState !== 'closed') {
            this.version.pc.close();
        }
        this.version.pc = null;
    }
    if (this.stream) {
        this.mute(false);
        this._stopStream(this.stream);
    }
    this.stream = null;
    this._removeReconnectionListeners();
    this._stopIceGatheringTimeout();
    Promise.all(this._removeAudioOutputs()).catch(function () {
        // We don't need to alert about failures here.
    });
    if (this._mediaStreamSource) {
        this._mediaStreamSource.disconnect();
    }
    if (this._inputAnalyser) {
        this._inputAnalyser.disconnect();
    }
    if (this._outputAnalyser) {
        this._outputAnalyser.disconnect();
    }
    if (this._inputAnalyser2) {
        this._inputAnalyser2.disconnect();
    }
    if (this._outputAnalyser2) {
        this._outputAnalyser2.disconnect();
    }
    this.status = 'closed';
    this.onclose();
};
PeerConnection.prototype.reject = function (callSid) {
    this.callSid = callSid;
};
PeerConnection.prototype.ignore = function (callSid) {
    this.callSid = callSid;
};
/**
 * Mute or unmute input audio. If the stream is not yet present, the setting
 *   is saved and applied to future streams/tracks.
 * @params {boolean} shouldMute - Whether the input audio should
 *   be muted or unmuted.
 */
PeerConnection.prototype.mute = function (shouldMute) {
    this.isMuted = shouldMute;
    if (!this.stream) {
        return;
    }
    if (this._sender && this._sender.track) {
        this._sender.track.enabled = !shouldMute;
    }
    else {
        var audioTracks = typeof this.stream.getAudioTracks === 'function'
            ? this.stream.getAudioTracks()
            : this.stream.audioTracks;
        audioTracks.forEach(function (track) {
            track.enabled = !shouldMute;
        });
    }
};
/**
 * Get or create an RTCDTMFSender for the first local audio MediaStreamTrack
 * we can get from the RTCPeerConnection. Return null if unsupported.
 * @instance
 * @returns ?RTCDTMFSender
 */
PeerConnection.prototype.getOrCreateDTMFSender = function getOrCreateDTMFSender() {
    if (this._dtmfSender || this._dtmfSenderUnsupported) {
        return this._dtmfSender || null;
    }
    var self = this;
    var pc = this.version.pc;
    if (!pc) {
        this._log.info('No RTCPeerConnection available to call createDTMFSender on');
        return null;
    }
    if (typeof pc.getSenders === 'function' && (typeof RTCDTMFSender === 'function' || typeof RTCDtmfSender === 'function')) {
        var chosenSender = pc.getSenders().find(function (sender) { return sender.dtmf; });
        if (chosenSender) {
            this._log.info('Using RTCRtpSender#dtmf');
            this._dtmfSender = chosenSender.dtmf;
            return this._dtmfSender;
        }
    }
    if (typeof pc.createDTMFSender === 'function' && typeof pc.getLocalStreams === 'function') {
        var track = pc.getLocalStreams().map(function (stream) {
            var tracks = self._getAudioTracks(stream);
            return tracks && tracks[0];
        })[0];
        if (!track) {
            this._log.info('No local audio MediaStreamTrack available on the RTCPeerConnection to pass to createDTMFSender');
            return null;
        }
        this._log.info('Creating RTCDTMFSender');
        this._dtmfSender = pc.createDTMFSender(track);
        return this._dtmfSender;
    }
    this._log.info('RTCPeerConnection does not support RTCDTMFSender');
    this._dtmfSenderUnsupported = true;
    return null;
};
/**
 * Get the RTCDtlTransport object from the PeerConnection
 * @returns RTCDtlTransport
 */
PeerConnection.prototype.getRTCDtlsTransport = function getRTCDtlsTransport() {
    var sender = this.version && this.version.pc
        && typeof this.version.pc.getSenders === 'function'
        && this.version.pc.getSenders()[0];
    return sender && sender.transport || null;
};
PeerConnection.prototype._canStopMediaStreamTrack = function () { return typeof MediaStreamTrack.prototype.stop === 'function'; };
PeerConnection.prototype._getAudioTracks = function (stream) { return typeof stream.getAudioTracks === 'function' ?
    stream.getAudioTracks() : stream.audioTracks; };
/**
 * Get the RTCIceTransport object from the PeerConnection
 * @returns RTCIceTransport
 */
PeerConnection.prototype._getRTCIceTransport = function _getRTCIceTransport() {
    var dtlsTransport = this.getRTCDtlsTransport();
    return dtlsTransport && dtlsTransport.iceTransport || null;
};
// Is PeerConnection.protocol used outside of our SDK? We should remove this if not.
PeerConnection.protocol = ((function () { return rtcpc_1.default.test() ? new rtcpc_1.default() : null; }))();
function addStream(pc, stream) {
    if (typeof pc.addTrack === 'function') {
        stream.getAudioTracks().forEach(function (track) {
            // The second parameters, stream, should not be necessary per the latest editor's
            //   draft, but FF requires it. https://bugzilla.mozilla.org/show_bug.cgi?id=1231414
            pc.addTrack(track, stream);
        });
    }
    else {
        pc.addStream(stream);
    }
}
function cloneStream(oldStream) {
    var newStream = typeof MediaStream !== 'undefined'
        ? new MediaStream()
        : new webkitMediaStream();
    oldStream.getAudioTracks().forEach(newStream.addTrack, newStream);
    return newStream;
}
function removeStream(pc, stream) {
    if (typeof pc.removeTrack === 'function') {
        pc.getSenders().forEach(function (sender) { pc.removeTrack(sender); });
    }
    else {
        pc.removeStream(stream);
    }
}
/**
 * Set the source of an HTMLAudioElement to the specified MediaStream
 * @param {HTMLAudioElement} audio
 * @param {MediaStream} stream
 * @returns {boolean} Whether the audio source was set successfully
 */
function setAudioSource(audio, stream) {
    if (typeof audio.srcObject !== 'undefined') {
        audio.srcObject = stream;
    }
    else if (typeof audio.mozSrcObject !== 'undefined') {
        audio.mozSrcObject = stream;
    }
    else if (typeof audio.src !== 'undefined') {
        var _window = audio.options.window || window;
        audio.src = (_window.URL || _window.webkitURL).createObjectURL(stream);
    }
    else {
        return false;
    }
    return true;
}
PeerConnection.enabled = rtcpc_1.default.test();
exports.default = PeerConnection;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGVlcmNvbm5lY3Rpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9saWIvdHdpbGlvL3J0Yy9wZWVyY29ubmVjdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBOzs7O0dBSUc7QUFDSCxjQUFjO0FBQ2Qsb0NBS21CO0FBQ25CLDhCQUF5QjtBQUN6Qiw4QkFBZ0M7QUFDaEMsaUNBQTRCO0FBQzVCLDZCQUFtRDtBQUVuRCxJQUFNLHFCQUFxQixHQUFHLEtBQUssQ0FBQztBQUNwQyxJQUFNLHVCQUF1QixHQUFHLE1BQU0sQ0FBQztBQUN2QyxJQUFNLDBCQUEwQixHQUFHLFNBQVMsQ0FBQztBQUM3QyxJQUFNLDRCQUE0QixHQUFHLEtBQUssQ0FBQztBQUMzQyxJQUFNLGtCQUFrQixHQUFHLEVBQUUsQ0FBQztBQUU5Qjs7Ozs7OztHQU9HO0FBQ0gsU0FBUyxjQUFjLENBQUMsV0FBVyxFQUFFLE9BQU8sRUFBRSxZQUFZLEVBQUUsT0FBTztJQUNqRSxJQUFJLENBQUMsV0FBVyxJQUFJLENBQUMsT0FBTyxJQUFJLENBQUMsWUFBWSxFQUFFO1FBQzdDLE1BQU0sSUFBSSw2QkFBb0IsQ0FBQyw4REFBOEQsQ0FBQyxDQUFDO0tBQ2hHO0lBRUQsSUFBSSxDQUFDLENBQUMsSUFBSSxZQUFZLGNBQWMsQ0FBQyxFQUFFO1FBQ3JDLE9BQU8sSUFBSSxjQUFjLENBQUMsV0FBVyxFQUFFLE9BQU8sRUFBRSxZQUFZLEVBQUUsT0FBTyxDQUFDLENBQUM7S0FDeEU7SUFFRCxJQUFJLENBQUMsSUFBSSxHQUFHLGFBQUcsQ0FBQyxXQUFXLEVBQUUsQ0FBQztJQUU5QixTQUFTLElBQUk7UUFDWCxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyx3Q0FBd0MsQ0FBQyxDQUFDO0lBQzNELENBQUM7SUFDRCxJQUFJLENBQUMsT0FBTyxHQUFHLElBQUksQ0FBQztJQUNwQixJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQztJQUNuQixJQUFJ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