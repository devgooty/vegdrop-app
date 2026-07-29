import React, { useState, useRef } from 'react';

export default function SplashScreen({ onComplete }) {
  const [isFading, setIsFading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef(null);

  const handleFinish = () => {
    setIsFading(true);
    // Wait for the fade-out transition to complete before unmounting
    setTimeout(() => {
      onComplete();
    }, 700);
  };

  const handleVideoPlay = () => {
    if (isPlaying) return; // Ensure this only triggers once
    setIsPlaying(true);
    
    // Maintain the 2x speed for fast, energetic motion
    if (videoRef.current) {
      videoRef.current.playbackRate = 2.0;
    }

    // Force transition exactly 2.3 seconds after the video actually starts playing
    // (2.3s play time + 0.7s fade out transition = exactly 3 seconds total)
    setTimeout(() => {
      handleFinish();
    }, 2300);
  };

  return (
    <div 
      className={`fixed inset-0 z-[9999] flex justify-center bg-[#F8F5EF] transition-all duration-700 ease-out ${
        isFading ? 'opacity-0 pointer-events-none blur-md scale-[1.02]' : 'opacity-100 blur-0 scale-100'
      }`}
    >
      <div className="w-full max-w-md h-full relative bg-black shadow-[0_0_60px_rgba(0,0,0,0.15)] flex flex-col items-center justify-center overflow-hidden border-x border-gray-200">
        
        {/* The video with a cinematic slow zoom-out effect */}
        <video 
          ref={videoRef}
          src="/splash.mp4" 
          autoPlay 
          muted 
          playsInline
          onPlaying={handleVideoPlay}
          className={`w-full h-full object-cover transition-all duration-[3000ms] ease-out ${
            isPlaying && !isFading ? 'scale-100 brightness-100' : 'scale-110 brightness-75'
          }`}
        />

        {/* Cinematic Overlays: Adds a premium, Hollywood-style look to the video */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-black/30 pointer-events-none"></div>
        <div className="absolute inset-0 bg-[#1B4D3E]/10 pointer-events-none mix-blend-color"></div>

        {/* Elegant Branding Fade-in over the video */}
        <div className={`absolute bottom-20 flex flex-col items-center transition-all duration-1000 delay-100 ${
          isPlaying && !isFading ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
        }`}>
          <div className="w-12 h-12 mb-3 rounded-2xl bg-gradient-to-b from-[#3B7A57] to-[#1C4D38] text-white flex items-center justify-center font-bold text-2xl shadow-2xl border border-emerald-400/30">
            🌿
          </div>
          <h1 className="font-vintage text-4xl font-black text-white tracking-tight drop-shadow-xl">
            VegBazzar
          </h1>
          <p className="mt-1.5 text-[10px] font-bold text-emerald-300 uppercase tracking-widest drop-shadow-lg flex items-center gap-2">
            <span className="w-1 h-1 rounded-full bg-emerald-400"></span>
            Artisanal Fresh Basket
            <span className="w-1 h-1 rounded-full bg-emerald-400"></span>
          </p>
        </div>

      </div>
    </div>
  );
}
