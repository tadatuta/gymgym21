export interface TypeaheadItem {
    id: string;
    name: string;
}

export interface TypeaheadOptions {
    items: TypeaheadItem[];
    selectedId?: string;
    name: string;
    placeholder?: string;
    inputId?: string;
}

/**
 * Fuzzy match: checks if all characters in `query` appear sequentially in `text` (case-insensitive).
 * Returns matched character indices or null if no match.
 */
function fuzzyMatch(text: string, query: string): number[] | null {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const indices: number[] = [];
    let qi = 0;

    for (let i = 0; i < lowerText.length && qi < lowerQuery.length; i++) {
        if (lowerText[i] === lowerQuery[qi]) {
            indices.push(i);
            qi++;
        }
    }

    return qi === lowerQuery.length ? indices : null;
}

/**
 * Highlights matched characters in `text` using <mark> tags.
 */
function highlightMatches(text: string, indices: number[]): string {
    if (indices.length === 0) return escapeHtml(text);

    const indexSet = new Set(indices);
    let result = '';
    let inMark = false;

    for (let i = 0; i < text.length; i++) {
        if (indexSet.has(i)) {
            if (!inMark) {
                result += '<mark class="typeahead__highlight">';
                inMark = true;
            }
            result += escapeHtml(text[i]);
        } else {
            if (inMark) {
                result += '</mark>';
                inMark = false;
            }
            result += escapeHtml(text[i]);
        }
    }
    if (inMark) result += '</mark>';

    return result;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Renders the typeahead HTML string.
 */
export function renderTypeahead(options: TypeaheadOptions): string {
    const { items, selectedId, name, placeholder, inputId } = options;
    const selected = items.find(i => i.id === selectedId);
    const hiddenValue = selected ? selected.id : (items[0]?.id || '');
    const displayInitial = selected ? selected.name : (items[0]?.name || '');

    return `
    <div class="typeahead" data-typeahead>
      <input
        type="text"
        class="typeahead__input"
        autocomplete="off"
        value="${escapeHtml(displayInitial)}"
        placeholder="${escapeHtml(placeholder || 'Поиск...')}"
        data-typeahead-input
      >
      <input
        type="hidden"
        name="${escapeHtml(name)}"
        ${inputId ? `id="${escapeHtml(inputId)}"` : ''}
        value="${escapeHtml(hiddenValue)}"
        data-typeahead-value
        required
      >
      <div class="typeahead__dropdown" data-typeahead-dropdown></div>
    </div>
  `;
}

/**
 * Returns the current typeahead value (hidden input), or falls back to a <select> value.
 */
export function getTypeaheadValue(container: Element | Document = document): string {
    const hidden = container.querySelector('[data-typeahead-value]') as HTMLInputElement | null;
    if (hidden) return hidden.value;

    const select = container.querySelector('select[name="typeId"]') as HTMLSelectElement | null;
    return select?.value || '';
}

/**
 * Binds all event listeners for the typeahead component.
 * Must be called after rendering.
 */
export function bindTypeahead(container: Element | Document = document): void {
    const wrapper = container.querySelector('[data-typeahead]') as HTMLElement | null;
    if (!wrapper) return;

    const input = wrapper.querySelector('[data-typeahead-input]') as HTMLInputElement;
    const hidden = wrapper.querySelector('[data-typeahead-value]') as HTMLInputElement;
    const dropdown = wrapper.querySelector('[data-typeahead-dropdown]') as HTMLElement;

    // Parse items from the hidden input's context — we need items stored somewhere.
    // We'll read them from a data attribute on the wrapper.
    // Actually, let's use a module-level map to avoid DOM pollution.
    const itemsMap = _typeaheadItems;
    const items = itemsMap.get(wrapper) || [];

    let activeIndex = -1;
    let filteredItems: { item: TypeaheadItem; indices: number[] }[] = [];
    let isOpen = false;

    function renderDropdown(query: string) {
        if (query.trim() === '') {
            // Show all items
            filteredItems = items.map(item => ({ item, indices: [] }));
        } else {
            filteredItems = [];
            for (const item of items) {
                const indices = fuzzyMatch(item.name, query);
                if (indices) {
                    filteredItems.push({ item, indices });
                }
            }
        }

        if (filteredItems.length === 0) {
            dropdown.innerHTML = '<div class="typeahead__empty">Ничего не найдено</div>';
        } else {
            dropdown.innerHTML = filteredItems.map((f, i) => {
                const label = f.indices.length > 0
                    ? highlightMatches(f.item.name, f.indices)
                    : escapeHtml(f.item.name);
                return `<div class="typeahead__option ${i === activeIndex ? 'typeahead__option_active' : ''}" data-typeahead-option-index="${i}" data-id="${escapeHtml(f.item.id)}">${label}</div>`;
            }).join('');
        }
    }

    function openDropdown() {
        if (isOpen) return;
        isOpen = true;
        activeIndex = -1;
        renderDropdown(input.value);
        dropdown.classList.add('typeahead__dropdown_open');
    }

    function closeDropdown() {
        if (!isOpen) return;
        isOpen = false;
        dropdown.classList.remove('typeahead__dropdown_open');
        activeIndex = -1;
    }

    function selectItem(item: TypeaheadItem) {
        input.value = item.name;
        hidden.value = item.id;
        closeDropdown();
        // Dispatch change event so updateFormVisibility and filter work
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function updateActiveOption() {
        dropdown.querySelectorAll('.typeahead__option').forEach((el, i) => {
            el.classList.toggle('typeahead__option_active', i === activeIndex);
        });

        // Scroll active option into view
        const activeEl = dropdown.querySelector('.typeahead__option_active') as HTMLElement;
        if (activeEl) {
            activeEl.scrollIntoView({ block: 'nearest' });
        }
    }

    // Events
    input.addEventListener('focus', () => {
        input.select();
        openDropdown();
    });

    input.addEventListener('input', () => {
        activeIndex = -1;
        openDropdown();
        renderDropdown(input.value);
    });

    input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (!isOpen) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                openDropdown();
                return;
            }
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (filteredItems.length > 0) {
                    activeIndex = (activeIndex + 1) % filteredItems.length;
                    updateActiveOption();
                }
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (filteredItems.length > 0) {
                    activeIndex = activeIndex <= 0 ? filteredItems.length - 1 : activeIndex - 1;
                    updateActiveOption();
                }
                break;
            case 'Enter':
                e.preventDefault();
                if (activeIndex >= 0 && activeIndex < filteredItems.length) {
                    selectItem(filteredItems[activeIndex].item);
                } else if (filteredItems.length === 1) {
                    selectItem(filteredItems[0].item);
                }
                break;
            case 'Escape':
                closeDropdown();
                input.blur();
                break;
        }
    });

    // Handle blur — restore display value if nothing was selected
    input.addEventListener('blur', () => {
        // Delay to allow click on option to fire first
        setTimeout(() => {
            if (!isOpen) return;
            // Restore the displayed name for the current hidden value
            const currentItem = items.find(i => i.id === hidden.value);
            if (currentItem) {
                input.value = currentItem.name;
            }
            closeDropdown();
        }, 200);
    });

    // Click on option
    dropdown.addEventListener('click', (e: Event) => {
        const target = (e.target as HTMLElement).closest('[data-typeahead-option-index]') as HTMLElement | null;
        if (!target) return;

        const index = parseInt(target.getAttribute('data-typeahead-option-index') || '-1', 10);
        if (index >= 0 && index < filteredItems.length) {
            selectItem(filteredItems[index].item);
        }
    });

    // Close on outside click
    document.addEventListener('click', (e: Event) => {
        if (!wrapper.contains(e.target as Node)) {
            const currentItem = items.find(i => i.id === hidden.value);
            if (currentItem) {
                input.value = currentItem.name;
            }
            closeDropdown();
        }
    });
}

/**
 * Module-level storage for typeahead items, keyed by wrapper element.
 * Call `registerTypeaheadItems` after rendering.
 */
const _typeaheadItems = new WeakMap<Element, TypeaheadItem[]>();

/**
 * Registers the items for the typeahead component.
 * Must be called after the DOM is rendered and before bindTypeahead.
 */
export function registerTypeaheadItems(container: Element | Document, items: TypeaheadItem[]): void {
    const wrapper = container.querySelector('[data-typeahead]') as HTMLElement | null;
    if (wrapper) {
        _typeaheadItems.set(wrapper, items);
    }
}
