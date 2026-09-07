type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type Field = { value: string; checked?: boolean; selection?: [number, number, 'forward' | 'backward' | 'none'] };
const controls = (root: ParentNode) => Array.from(root.querySelectorAll<Control>('input:not([type=file]):not([type=password]), select, textarea'));
const fieldKey = (field: Control) => field.id || (field.hasAttribute('data-typeahead-input')
    ? 'typeahead-query' : `${field.name}:${field.type}:${field.type === 'radio' ? field.value : ''}`);

/** Memory-only drafts. DOM scopes belong to the account/route/entity that rendered them. */
export class FormDrafts {
    private account: string | null = null;
    private epoch = 0;
    private drafts = new Map<string, Map<string, Field>>();
    private scopes = new WeakMap<Element, string>();
    private focus: { scope: string; field: string; selection?: Field['selection'] } | null = null;
    private restoring = false;
    private revisions = new Map<string, number>();
    private sequence = 0;
    private readonly changed = (event: Event) => {
        if (this.restoring || !(event.target instanceof Element)) return;
        const group = this.group(event.target);
        if (group) this.capture(group, true);
    };
    constructor(private readonly root: HTMLElement) {
        root.addEventListener('input', this.changed);
        root.addEventListener('change', this.changed);
    }
    private group(element: Element) { return element.closest('form, #profile-tab-content'); }
    private capture(group: Element, dirty = false) {
        const scope = this.scopes.get(group);
        if (!scope || (!dirty && !this.drafts.has(scope))) return;
        if (dirty) this.revisions.set(scope, ++this.sequence);
        const previous = this.drafts.get(scope);
        const fields = new Map<string, Field>();
        controls(group).forEach((field) => {
            if (!dirty && !previous?.has(fieldKey(field))) return;
            const value: Field = { value: field.value };
            if (field instanceof HTMLInputElement) value.checked = field.checked;
            if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.selectionStart !== null) {
                value.selection = [field.selectionStart, field.selectionEnd!, field.selectionDirection || 'none'];
            }
            const key = fieldKey(field);
            fields.set(key, value);
            if (document.activeElement === field) this.focus = { scope, field: key, selection: value.selection };
        });
        this.drafts.set(scope, fields);
    }
    /** A successful save clears only its submitted generation, even across rerenders. */
    checkpoint(groupId: string, keepFields: string[] = []): () => boolean {
        const group = this.root.querySelector(`#${groupId}`);
        const scope = group && this.scopes.get(group);
        if (scope && !this.revisions.has(scope)) this.revisions.set(scope, ++this.sequence);
        const revision = scope && this.revisions.get(scope);
        const epoch = this.epoch;
        return () => {
            if (!scope || epoch !== this.epoch || this.revisions.get(scope) !== revision) return false;
            const retained = new Map([...this.drafts.get(scope) || []].filter(([key]) => keepFields.includes(key)));
            if (retained.size) {
                this.drafts.set(scope, retained);
                this.revisions.set(scope, ++this.sequence);
            } else {
                this.drafts.delete(scope);
                this.revisions.delete(scope);
            }
            if (this.focus?.scope === scope) this.focus = null;
            const current = this.root.querySelector(`#${groupId}`);
            return !current || this.scopes.get(current) === scope;
        };
    }
    clear(groupId: string) { this.checkpoint(groupId)(); }
    render(account: string | null, scopeFor: (group: Element) => string, update: () => void) {
        if (account !== this.account) {
            this.epoch += 1;
            this.drafts.clear();
            this.revisions.clear();
            this.scopes = new WeakMap();
            this.account = account;
        }
        this.focus = null;
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) {
            const group = this.group(active);
            const scope = group && this.scopes.get(group);
            if (scope) {
                this.focus = { scope, field: fieldKey(active) };
                if (!(active instanceof HTMLSelectElement) && active.selectionStart !== null) {
                    this.focus.selection = [active.selectionStart, active.selectionEnd!, active.selectionDirection || 'none'];
                }
            }
        }
        this.root.querySelectorAll('form, #profile-tab-content').forEach(group => this.capture(group));
        update();
        this.restoring = true;
        try {
            this.root.querySelectorAll('form, #profile-tab-content').forEach(group => {
                const scope = JSON.stringify([account, scopeFor(group)]);
                this.scopes.set(group, scope);
                const draft = this.drafts.get(scope);
                controls(group).forEach((field) => {
                    const key = fieldKey(field);
                    const value = draft?.get(key);
                    if (!value) return;
                    field.value = value.value;
                    if (field instanceof HTMLInputElement && value.checked !== undefined) field.checked = value.checked;
                });
                group.dispatchEvent(new Event('draftrestore'));
                controls(group).forEach((field) => {
                    const key = fieldKey(field);
                    if (this.focus?.scope !== scope || this.focus.field !== key) return;
                    field.focus({ preventScroll: true });
                    const selection = this.focus.selection;
                    if (selection && (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) field.setSelectionRange(...selection);
                });
            });
        } finally { this.restoring = false; }
    }
    dispose() {
        this.epoch += 1;
        this.root.removeEventListener('input', this.changed);
        this.root.removeEventListener('change', this.changed);
        this.drafts.clear();
        this.revisions.clear();
        this.scopes = new WeakMap();
        this.focus = null;
    }
}
