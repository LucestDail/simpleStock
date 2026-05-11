import { ref } from 'vue';

const dialog = ref({
  open: false,
  title: '',
  message: '',
  confirmLabel: '확인',
  cancelLabel: '취소',
  tone: 'default',
});

const toast = ref({
  open: false,
  message: '',
  tone: 'info',
});

let activeResolver = null;
let toastTimer = null;

function closeDialog() {
  dialog.value = {
    open: false,
    title: '',
    message: '',
    confirmLabel: '확인',
    cancelLabel: '취소',
    tone: 'default',
  };
}

function settleDialog(result) {
  if (activeResolver) {
    activeResolver(result);
    activeResolver = null;
  }
  closeDialog();
}

function confirmAction({
  title = '확인',
  message = '',
  confirmLabel = '확인',
  cancelLabel = '취소',
  tone = 'default',
} = {}) {
  if (activeResolver) {
    activeResolver(false);
    activeResolver = null;
  }

  dialog.value = {
    open: true,
    title,
    message,
    confirmLabel,
    cancelLabel,
    tone,
  };

  return new Promise((resolve) => {
    activeResolver = resolve;
  });
}

function dismissToast() {
  toast.value = {
    open: false,
    message: '',
    tone: 'info',
  };
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

function notify({ message = '', tone = 'info', duration = 2800 } = {}) {
  if (toastTimer) {
    clearTimeout(toastTimer);
  }

  toast.value = {
    open: true,
    message,
    tone,
  };

  toastTimer = setTimeout(() => {
    dismissToast();
  }, duration);
}

export function useUi() {
  return {
    dialog,
    toast,
    confirmAction,
    notify,
    dismissToast,
    confirmDialog: () => settleDialog(true),
    cancelDialog: () => settleDialog(false),
  };
}
