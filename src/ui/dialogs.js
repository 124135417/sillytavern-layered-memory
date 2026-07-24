function restoreFocus(element) {
    if (element instanceof HTMLElement && element.isConnected) {
        element.focus({ preventScroll: true });
    }
}

function appendText(element, value) {
    element.textContent = String(value ?? '');
    return element;
}

function makeElement(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) appendText(element, text);
    return element;
}

export function openFormDialog({
    kicker = '',
    title,
    description = '',
    submitLabel,
    cancelLabel = '不保存',
    tone = 'default',
    className = '',
    buildFields,
    readValue,
    validate,
    initialFocus,
} = {}) {
    const previousFocus = document.activeElement;
    const dialog = makeElement('dialog', `lm-dialog lm-action-dialog ${className}`.trim());
    const form = makeElement('form', 'lm-dialog-frame lm-action-form');
    form.method = 'dialog';

    const header = makeElement('header');
    const heading = makeElement('div');
    if (kicker) heading.appendChild(makeElement('span', 'lm-kicker', kicker));
    const titleElement = makeElement('h3', '', title);
    heading.appendChild(titleElement);
    const close = makeElement('button', 'lm-icon-button', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    header.append(heading, close);

    const content = makeElement('div', 'lm-dialog-content');
    if (description) content.appendChild(makeElement('p', 'lm-dialog-description', description));
    const fields = makeElement('div', 'lm-dialog-fields');
    buildFields?.(fields, dialog);
    content.appendChild(fields);
    const error = makeElement('p', 'lm-dialog-error');
    error.id = `lm-dialog-error-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    error.setAttribute('role', 'alert');
    error.setAttribute('aria-live', 'polite');
    error.hidden = true;
    content.appendChild(error);

    const footer = makeElement('footer');
    const cancel = makeElement('button', 'lm-text-button', cancelLabel);
    cancel.type = 'button';
    const submit = makeElement('button', `lm-button ${tone === 'danger' ? 'lm-button-danger' : 'lm-button-primary'}`, submitLabel);
    submit.type = 'submit';
    footer.append(cancel, submit);
    form.append(header, content, footer);
    dialog.appendChild(form);
    document.body.appendChild(dialog);

    const promise = new Promise(resolve => {
        const finish = value => {
            dialog.remove();
            restoreFocus(previousFocus);
            resolve(value);
        };
        const cancelDialog = () => dialog.close('cancel');
        close.addEventListener('click', cancelDialog);
        cancel.addEventListener('click', cancelDialog);
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            cancelDialog();
        });
        form.addEventListener('submit', event => {
            event.preventDefault();
            const value = readValue?.(form, dialog);
            const validationMessage = validate?.(value, form, dialog);
            if (validationMessage) {
                error.textContent = validationMessage;
                error.hidden = false;
                return;
            }
            dialog.__lmValue = value;
            dialog.returnValue = 'submit';
            dialog.close('submit');
        });
        dialog.addEventListener('close', () => {
            finish(dialog.returnValue === 'submit' ? dialog.__lmValue : null);
        }, { once: true });
    });

    dialog.showModal();
    const focusTarget = typeof initialFocus === 'string'
        ? dialog.querySelector(initialFocus)
        : initialFocus?.(dialog);
    (focusTarget || dialog.querySelector('input, textarea, select, button'))?.focus();
    return promise;
}

export async function openConfirmDialog({
    kicker = '请确认',
    title,
    description,
    details = [],
    confirmLabel,
    cancelLabel = '保留当前内容',
    tone = 'danger',
} = {}) {
    const result = await openFormDialog({
        kicker,
        title,
        description,
        submitLabel: confirmLabel,
        cancelLabel,
        tone,
        buildFields(fields) {
            if (!details.length) return;
            const list = makeElement('ul', 'lm-dialog-detail-list');
            for (const detail of details) list.appendChild(makeElement('li', '', detail));
            fields.appendChild(list);
        },
        readValue: () => true,
    });
    return result === true;
}

export function openTextEditorDialog({
    kicker = '人工修改',
    title,
    description,
    label,
    value = '',
    sourceSections = [],
    saveLabel = '保存修改',
    cancelLabel = '不保存',
    maxLength = 4000,
} = {}) {
    return openFormDialog({
        kicker,
        title,
        description,
        submitLabel: saveLabel,
        cancelLabel,
        className: 'lm-editor-dialog',
        buildFields(fields) {
            if (sourceSections.length) {
                const source = makeElement('section', 'lm-dialog-source');
                source.appendChild(makeElement('h4', '', '原文参考'));
                for (const item of sourceSections) {
                    const block = makeElement('div', 'lm-dialog-source-block');
                    block.append(makeElement('strong', '', item.label), makeElement('p', '', item.text));
                    source.appendChild(block);
                }
                fields.appendChild(source);
            }
            const field = makeElement('label', 'lm-dialog-field');
            field.appendChild(makeElement('span', '', label));
            const textarea = makeElement('textarea');
            textarea.name = 'value';
            textarea.required = true;
            textarea.maxLength = maxLength;
            textarea.rows = 8;
            textarea.value = String(value ?? '');
            field.appendChild(textarea);
            fields.appendChild(field);
        },
        readValue: form => String(new FormData(form).get('value') || '').trim(),
        validate: edited => edited ? '' : `请填写${label}`,
        initialFocus: '[name="value"]',
    });
}

export function openMessageDialog({ kicker = '提示', title, description, closeLabel = '关闭' } = {}) {
    return openFormDialog({
        kicker,
        title,
        description,
        submitLabel: closeLabel,
        cancelLabel: closeLabel,
        buildFields() {},
        readValue: () => true,
    });
}
