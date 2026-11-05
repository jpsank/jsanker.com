// Retrieve dom elements

// Control elements
const currentImg = document.getElementById('current_img');
const playBtn = document.getElementById('play');
const progressBar = document.getElementById('audioProgress');

// Display elements
const scroller = document.querySelector("#scroller");
const template = document.querySelector('#track_template');
const sentinel = document.querySelector('#sentinel');

// The original used an <audio> element fed by mp3 files. In this demo the tracks are fictional and
// synthesised, so `audio` is a thin stand-in with the same bits of the HTMLAudioElement API that
// script.js uses (play, pause, paused, load, currentTime, duration, onended, ontimeupdate).
const synthEngine = window.UMusicSynth && window.UMusicSynth.Engine.supported ? new window.UMusicSynth.Engine() : null;
const audio = {
    onended: null,
    ontimeupdate: null,
    get paused() { return !synthEngine || !synthEngine.playing; },
    get currentTime() { return synthEngine ? synthEngine.position() : 0; },
    set currentTime(t) { if (synthEngine) synthEngine.seek(t); },
    get duration() { return synthEngine ? synthEngine.duration() : 0; },
    load(track) { if (synthEngine) synthEngine.load(track); },
    play() { return synthEngine ? synthEngine.play() : Promise.resolve(); },
    pause() { if (synthEngine) synthEngine.pause(); }
};
if (synthEngine) {
    synthEngine.setVolume(0.7);
    synthEngine.onEnded = function () { if (audio.onended) audio.onended(); };
}
