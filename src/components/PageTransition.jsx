import React, { useEffect, useState } from 'react';

/**
 * Smooth fade/slide transition wrapper for tab/view changes.
 * Wraps any content and animates it in when the `transitionKey` changes.
 */
export default function PageTransition({ children, transitionKey }) {
  const [displayKey, setDisplayKey] = useState(transitionKey);
  const [phase, setPhase] = useState('in'); // 'in' | 'out'

  useEffect(() => {
    if (transitionKey !== displayKey) {
      setPhase('out');
      const timer = setTimeout(() => {
        setDisplayKey(transitionKey);
        setPhase('in');
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [transitionKey, displayKey]);

  return (
    <div
      className={`transition-all duration-200 ease-out ${
        phase === 'out'
          ? 'opacity-0 translate-y-2 scale-[0.99]'
          : 'opacity-100 translate-y-0 scale-100'
      }`}
    >
      {children}
    </div>
  );
}
