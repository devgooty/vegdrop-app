import React from 'react';
import CatalogSuggestionsQueue from '../../CatalogSuggestionsQueue';

/** Developer console: unscoped pending catalog suggestions. */
export default function CatalogSuggestionsView() {
  return (
    <div className="p-4 sm:p-6 max-w-3xl">
      <CatalogSuggestionsQueue />
    </div>
  );
}
