import React, { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import ProductGridCard from './ProductGridCard';

/**
 * The "keep scrolling and there is more" block under a product's details.
 *
 * Two bands, because they answer different questions. The rail is the same
 * shelf the shopper is already standing at — other sizes and varieties of the
 * thing they came for. The grid below is everything else, and it is a grid
 * rather than a second rail on purpose: a rail says "a few more of these",
 * a grid says "the shop continues", which is the one that keeps someone
 * scrolling.
 *
 * Both reuse ProductGridCard, so add-to-cart, the quantity stepper and the
 * weight variants behave exactly as they do everywhere else — a related item
 * that could only be viewed and not added would be the obvious thing to get
 * wrong here.
 */
export default function RelatedProducts({
  product,
  category,
  products = [],
  categories = [],
  cartItems,
  onAddToCart,
  onUpdateQuantity,
  onSelectProduct,
  onOpenCategory,
}) {
  const categoryById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories]
  );

  const { sameCategory, elsewhere } = useMemo(() => {
    // Compare against originalId too: a card adds variants to the cart under a
    // composite id like `<id>-500g`, and the product handed to this view can
    // carry one, which would otherwise fail to match itself and let an item
    // recommend itself.
    const currentId = product?.originalId ?? product?.id;
    const others = products.filter((p) => p.id !== currentId);

    const byRating = (a, b) => (b.rating ?? 0) - (a.rating ?? 0);

    return {
      sameCategory: others
        .filter((p) => p.categoryId === product?.categoryId)
        .sort(byRating)
        .slice(0, 10),
      elsewhere: others
        .filter((p) => p.categoryId !== product?.categoryId)
        .sort(byRating)
        .slice(0, 6),
    };
  }, [products, product]);

  if (sameCategory.length === 0 && elsewhere.length === 0) return null;

  return (
    <div className="space-y-6">
      {sameCategory.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-vintage text-base font-bold text-[#1B4D3E] tracking-tight">
              More from {category?.title || 'this section'}
            </h3>

            {category && onOpenCategory && (
              <button
                onClick={() => onOpenCategory(category)}
                className="text-xs font-bold text-[#C8372D] hover:text-[#9E2A22] flex items-center gap-0.5 hover:underline cursor-pointer"
              >
                <span>See All</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Bled to the screen edges so the row reads as continuing past the
              fold rather than stopping at the card's padding. */}
          <div className="flex gap-3 overflow-x-auto no-scrollbar snap-x snap-mandatory py-1 -mx-4 px-4 scroll-smooth">
            {sameCategory.map((item) => (
              <div key={item.id} className="w-40 shrink-0 snap-start">
                <ProductGridCard
                  item={item}
                  category={categoryById.get(item.categoryId)}
                  cartItems={cartItems}
                  onAddToCart={onAddToCart}
                  onUpdateQuantity={onUpdateQuantity}
                  onSelectProduct={onSelectProduct}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {elsewhere.length > 0 && (
        <section className="space-y-3">
          <h3 className="font-vintage text-base font-bold text-[#1B4D3E] tracking-tight">
            You might also like
          </h3>

          <div className="grid grid-cols-2 gap-3 items-start">
            {elsewhere.map((item) => (
              <ProductGridCard
                key={item.id}
                item={item}
                category={categoryById.get(item.categoryId)}
                cartItems={cartItems}
                onAddToCart={onAddToCart}
                onUpdateQuantity={onUpdateQuantity}
                onSelectProduct={onSelectProduct}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
