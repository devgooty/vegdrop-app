import React from 'react';

/**
 * Shimmer loading skeleton components for professional loading states.
 */

function Shimmer({ className = '' }) {
  return (
    <div className={`animate-shimmer bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 bg-[length:200%_100%] rounded-xl ${className}`} />
  );
}

export function ProductCardSkeleton() {
  return (
    <div className="w-44 flex-shrink-0 skeuo-card rounded-2xl p-2.5 space-y-2">
      <Shimmer className="w-full h-28 rounded-xl" />
      <Shimmer className="w-3/4 h-3 rounded-md" />
      <Shimmer className="w-1/2 h-3 rounded-md" />
      <div className="flex justify-between items-center pt-1">
        <Shimmer className="w-12 h-4 rounded-md" />
        <Shimmer className="w-16 h-7 rounded-lg" />
      </div>
    </div>
  );
}

export function CategorySkeleton() {
  return (
    <div className="skeuo-card rounded-2xl p-3 flex items-center gap-3">
      <Shimmer className="w-14 h-14 rounded-xl shrink-0" />
      <div className="flex-1 space-y-2">
        <Shimmer className="w-3/4 h-3.5 rounded-md" />
        <Shimmer className="w-1/2 h-2.5 rounded-md" />
        <Shimmer className="w-1/3 h-2.5 rounded-md" />
      </div>
    </div>
  );
}

export function HeroBannerSkeleton() {
  return (
    <div className="mx-4 mt-3 rounded-2xl overflow-hidden">
      <Shimmer className="w-full h-48 rounded-2xl" />
    </div>
  );
}

export function OrderCardSkeleton() {
  return (
    <div className="skeuo-card rounded-2xl p-4 space-y-3">
      <div className="flex justify-between">
        <Shimmer className="w-20 h-4 rounded-md" />
        <Shimmer className="w-16 h-5 rounded-full" />
      </div>
      <Shimmer className="w-3/4 h-3 rounded-md" />
      <Shimmer className="w-1/2 h-3 rounded-md" />
      <div className="flex gap-2 pt-1">
        <Shimmer className="w-20 h-7 rounded-lg" />
        <Shimmer className="w-20 h-7 rounded-lg" />
      </div>
    </div>
  );
}

export function HomeSkeleton() {
  return (
    <div className="space-y-5 animate-fade-in">
      {/* Hero Banner Skeleton */}
      <HeroBannerSkeleton />

      {/* Categories Skeleton */}
      <div className="px-4 space-y-3">
        <Shimmer className="w-32 h-5 rounded-md" />
        <div className="grid grid-cols-2 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <CategorySkeleton key={i} />
          ))}
        </div>
      </div>

      {/* Product Row Skeleton */}
      <div className="px-4 space-y-3">
        <Shimmer className="w-40 h-5 rounded-md" />
        <div className="flex gap-3.5 overflow-hidden">
          {[1, 2, 3].map((i) => (
            <ProductCardSkeleton key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
