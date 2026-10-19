// The bridge to the shop's product form: the customer's choices travel with the order as line item
// properties (hidden `properties[…]` inputs inside the form), the photo as a file property (a file
// input in the form, which Shopify uploads and turns into a link on the order), and the size picks
// the matching variant (the form's `id` input). The inputs live in the page's own DOM, not the
// widget's shadow DOM, so the form submits them like any of its fields.

const MARK = 'data-litho';

/** The product form: by id (the `form` attribute), else the form around the widget, else the page's first add-to-cart form. */
export function findProductForm(host: HTMLElement, formId: string | null): HTMLFormElement | null {
  if (formId) {
    const el = document.getElementById(formId);
    return el instanceof HTMLFormElement ? el : null;
  }
  return host.closest('form') ?? document.querySelector<HTMLFormElement>('form[action*="/cart/add"]');
}

export class FormBridge {
  private file: HTMLInputElement | null = null;
  private ready = false;
  private onSubmit = (e: Event) => {
    if (e.target !== this.form || this.ready) return;
    // No photo yet: keep the product out of the cart. In the capture phase on the document, so it
    // runs before the theme's own (AJAX) submit handler on the form.
    e.preventDefault();
    e.stopImmediatePropagation();
    this.blocked();
  };

  constructor(readonly form: HTMLFormElement, private blocked: () => void) {
    document.addEventListener('submit', this.onSubmit, true);
    // A file in the form needs a multipart request (themes that post FormData send it as one anyway).
    form.enctype = 'multipart/form-data';
  }

  /** Sets the line item properties (name → value); properties set before but missing now are removed. */
  setProperties(props: Record<string, string>) {
    const old = new Map([...this.form.querySelectorAll<HTMLInputElement>(`input[type=hidden][${MARK}]`)].map((i) => [i.name, i]));
    for (const [key, value] of Object.entries(props)) {
      const name = `properties[${key}]`;
      let input = old.get(name);
      old.delete(name);
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.setAttribute(MARK, '');
        this.form.appendChild(input);
      }
      input.value = value;
    }
    for (const input of old.values()) input.remove();
  }

  /** Attaches the photo as the file property `key` (null removes it). */
  setPhoto(key: string, photo: File | null) {
    if (!photo) { this.file?.remove(); this.file = null; this.ready = false; return; }
    if (!this.file) {
      this.file = document.createElement('input');
      this.file.type = 'file';
      this.file.hidden = true;
      this.file.setAttribute(MARK, '');
      this.form.appendChild(this.file);
    }
    this.file.name = `properties[${key}]`;
    try {
      const dt = new DataTransfer();
      dt.items.add(photo);
      this.file.files = dt.files;
      this.ready = this.file.files?.length === 1;
    } catch {
      // A browser that can't fill a file input from script (very old Safari): the order can't carry the photo.
      this.ready = false;
    }
  }

  /** Whether the form can carry the photo (the add-to-cart button is let through). */
  get hasPhoto() { return this.ready; }

  /** Selects the product variant (the form's `id` input), telling the theme it changed. */
  setVariant(id: string | number | undefined) {
    if (id == null) return;
    const input = this.form.querySelector<HTMLInputElement | HTMLSelectElement>('[name="id"]');
    if (!input || input.value === String(id)) return;
    input.value = String(id);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  dispose() {
    document.removeEventListener('submit', this.onSubmit, true);
    this.form.querySelectorAll(`[${MARK}]`).forEach((el) => el.remove());
  }
}
