import React from 'react';
import CatalogSuggestionsQueue from '../CatalogSuggestionsQueue';
import { initialCategories } from '../../data/mockData';

/** Developer console: unscoped pending catalog suggestions. */
export default function CatalogSuggestionsView() {
  return (
    <div className="p-4 sm:p-6 max-w-3xl">
      <CatalogSuggestionsQueue categories={initialCategories} />
    </div>
  );
}
