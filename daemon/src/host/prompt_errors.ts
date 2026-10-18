import { jsonEqual, text } from './json';

/** Errors that Pi reports for a prompt through events, before it answers the prompt request. */
export class PromptErrors {
  private inputRejection: any = null;
  private commandErrors = new Map<string, string>();

  /** Forgets the errors of earlier prompts. */
  reset(): void {
    this.inputRejection = null;
    this.commandErrors.clear();
  }

  /** Records the input that an extension rejected, with its error. */
  rejectInput(rejection: any): void { this.inputRejection = rejection; }

  /** Marks an error notice that tells about the rejected input. */
  markNotice(event: any): void {
    if (event.method === 'notify' && event.notifyType === 'error' && jsonEqual(event.message, this.inputRejection?.error)) event.inputRejected = true;
  }

  /** Records a failed extension command. */
  commandFailed(event: any): void {
    const path = typeof event.extensionPath === 'string' ? event.extensionPath : '';
    const command = path.startsWith('command:') ? path.slice(8) : '';
    this.commandErrors.set(command, typeof event.error === 'string' ? event.error : 'Extension command failed');
  }

  /** Throws the recorded error for this prompt. */
  check(command: any, submittedText: any): void {
    const message = text(command, 'message');
    const commandName = message.startsWith('/') ? (message.slice(1).split(/\s+/).find(part => part) ?? '') : '';
    const error = this.commandErrors.get(commandName) ?? this.commandErrors.get('');
    if (error !== undefined) throw new Error(error);
    const rejected = this.inputRejection?.text;
    if (jsonEqual(rejected, message) || (typeof submittedText === 'string' && jsonEqual(rejected, submittedText))) {
      if (typeof this.inputRejection?.error === 'string') throw new Error(this.inputRejection.error);
    }
  }
}
