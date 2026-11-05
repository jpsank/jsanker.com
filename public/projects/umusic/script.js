// Button Controls //

function setPauseIcon() {
    playBtn.classList.remove('glyphicon-play');
    playBtn.classList.add('glyphicon-pause');
}
function setPlayIcon() {
    playBtn.classList.add('glyphicon-play');
    playBtn.classList.remove('glyphicon-pause');
}

function playAudio() {
    audio.play();
    setPauseIcon();
}
function pauseAudio() {
    audio.pause();
    setPlayIcon();
}

function buttonPlay() {
    if (audio.paused) {
        playAudio();
    } else {
        pauseAudio();
    }
}


// Changing Track //

let currentTrack = null;


function setCurrentTrack(newTrack) {
    currentTrack = newTrack;

    // Set cover image
    let img = currentTrack.querySelector('img');
    currentImg.src = img.src;
    currentImg.alt = img.alt;

    // Show what is playing
    let info = window.UMUSIC_TRACKS.find((t) => t.id === currentTrack.id);
    document.getElementById('title').textContent = info ? info.title + ' — ' + info.artist : '';

    // Load audio (synthesised from the track's score)
    progressBar.value = 0;
    audio.load(info);
}
function playThisTrack(track) {
    setCurrentTrack(track);
    playAudio();
}

function playPrev() {
    if (currentTrack) {
        let track = currentTrack.previousElementSibling;
        if (track) {
            track.classList.remove('done');
            playThisTrack(track);
        }
    }
}

function playNext() {
    if (currentTrack) {
        currentTrack.classList.add('done');

        // If we can, play the next track after currentTrack
        let track = currentTrack.nextElementSibling;
        if (track) {
            track.classList.remove('done');
            playThisTrack(track);
            return;
        }
    }

    // Otherwise, play the first track that hasn't already been played
    let track = document.querySelector('.track:not(.done)');
    if (track) {
        playThisTrack(track);
    } else {
        setPlayIcon();
    }
}

// Initialize with first track
function setup() {
    let track = document.querySelector('.track');
    setCurrentTrack(track);
}

audio.onended = function () {
    playNext();
};


// Progress Bar

function initProgressBar() {
    if (audio.currentTime) {
        progressBar.value = (audio.currentTime / audio.duration);
    }
}
audio.ontimeupdate = initProgressBar;
// stand-in for the <audio> element's timeupdate event
setInterval(function () {
    if (!audio.paused && audio.ontimeupdate) {
        audio.ontimeupdate();
    }
}, 250);

progressBar.addEventListener("click", function (event) {
    let percent = event.offsetX / this.offsetWidth;
    audio.currentTime = percent * audio.duration;
    progressBar.value = percent;
});


// Keyboard Controls //

document.addEventListener("keydown", function(e) {
    // Play/pause controlled by space
    if (e.code === 'Space') {
        e.preventDefault();
        buttonPlay();
    } else if (e.code === 'ArrowRight') {
        playNext();
    } else if (e.code === 'ArrowLeft') {
        playPrev();
    }
});


// Shuffle tracks

function shuffle() {
    // Fisher-Yates shuffle
    for (let i = scroller.children.length; i >= 0; i--) {
        scroller.appendChild(scroller.children[Math.random() * i | 0]);
    }
}


// Buttons (the original used inline onclick handlers)

document.getElementById('shuffle').addEventListener('click', shuffle);
document.getElementById('play').addEventListener('click', buttonPlay);
document.getElementById('prev').addEventListener('click', playPrev);
document.getElementById('next').addEventListener('click', playNext);
scroller.addEventListener('click', function (e) {
    let track = e.target.closest('.track');
    if (track) {
        playThisTrack(track);
    }
});
