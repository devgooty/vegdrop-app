import React, { useEffect, useState } from 'react';

export default function FlyToCartOverlay({ flyingItems, onAnimationEnd }) {
  return (
    <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
      {flyingItems.map((item) => (
        <FlyingItemBadge
          key={item.id}
          item={item}
          onEnd={() => onAnimationEnd(item.id)}
        />
      ))}
    </div>
  );
}

function FlyingItemBadge({ item, onEnd }) {
  const [styleX, setStyleX] = useState({
    left: `${item.startPos.x}px`,
    transition: 'none',
  });
  
  const [styleY, setStyleY] = useState({
    top: `${item.startPos.y}px`,
    width: '90px',
    height: '90px',
    opacity: 1,
    transform: 'scale(1.2) rotate(-10deg)',
    transition: 'none',
  });

  useEffect(() => {
    // Target position is the bottom cart icon
    const cartEl = document.getElementById('bottom-cart-button');
    let targetX = window.innerWidth / 2 - 20;
    let targetY = window.innerHeight - 50;

    if (cartEl) {
      const rect = cartEl.getBoundingClientRect();
      targetX = rect.left + rect.width / 2 - 20;
      targetY = rect.top + rect.height / 2 - 20;
    }

    // Trigger smooth parabolic "throw" animation
    const timer = setTimeout(() => {
      // X-axis: moves linearly/ease-in-out towards the cart
      setStyleX({
        left: `${targetX}px`,
        transition: 'left 0.75s linear',
      });
      
      // Y-axis: Uses a custom bezier curve to jump UP slightly, then fall down rapidly!
      // Also scale down, fade, and spin for a dramatic effect
      setStyleY({
        top: `${targetY}px`,
        width: '24px',
        height: '24px',
        opacity: 0.2,
        transform: 'scale(0.1) rotate(540deg)',
        transition: 'top 0.75s cubic-bezier(0.5, -0.8, 1, 0.5), width 0.75s ease-in, height 0.75s ease-in, transform 0.75s ease-in, opacity 0.75s cubic-bezier(0.8, 0, 1, 1)',
      });
    }, 20);

    const endTimer = setTimeout(() => {
      onEnd();
    }, 750);

    return () => {
      clearTimeout(timer);
      clearTimeout(endTimer);
    };
  }, [item, onEnd]);

  return (
    <div
      className="fixed top-0 z-[1500] pointer-events-none"
      style={styleX}
    >
      <div
        className="absolute bg-[#FFFDF9] border-2 border-emerald-500 rounded-full p-1 shadow-[0_20px_40px_rgba(27,77,62,0.4)] flex flex-col items-center justify-center overflow-hidden"
        style={styleY}
      >
        <img
          src={item.image}
          alt=""
          className="w-full h-full object-cover rounded-full bg-white"
        />
      </div>
    </div>
  );
}
