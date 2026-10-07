import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import digiShopEmblem from '../assets/digishop-emblem.webp';

export default function DigiShopQuickAction() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          data-testid="quick-action-digishop"
          className="group flex flex-col items-center gap-1.5 rounded-xl py-2.5 transition-colors hover:bg-slate-50 active:scale-95 sm:gap-2 sm:py-3"
        >
          <span className="h-10 w-10 overflow-hidden rounded-full ring-1 ring-slate-200/70 transition-transform group-hover:scale-105 sm:h-12 sm:w-12">
            <img
              src={digiShopEmblem}
              alt=""
              aria-hidden="true"
              className="h-full w-full rounded-full object-cover"
              decoding="async"
            />
          </span>
          <span className="font-cabinet text-[10px] font-bold text-slate-900 sm:text-xs">
            DigiShop
          </span>
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-slate-950/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-testid="digishop-modal"
          className="fixed left-1/2 top-1/2 z-[71] w-[calc(100vw-2rem)] max-w-xs -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-2xl focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label="Fermer"
              data-testid="digishop-close"
              className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </Dialog.Close>
          <div className="mx-auto h-16 w-16 overflow-hidden rounded-full ring-1 ring-slate-200/70">
            <img
              src={digiShopEmblem}
              alt=""
              aria-hidden="true"
              className="h-full w-full rounded-full object-cover"
              decoding="async"
            />
          </div>
          <Dialog.Title className="mt-3 font-cabinet text-lg font-extrabold text-slate-900">
            DigiShop
          </Dialog.Title>
          <Dialog.Description asChild>
            <p
              data-testid="digishop-status"
              className="mt-2 text-sm font-medium text-slate-600"
            >
              Bientôt disponible 🚀
            </p>
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
