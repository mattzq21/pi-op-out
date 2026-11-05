import { jsonEqual, text } from './json';

export class PromptErrors {
  private inputRejection: any = null;
  private commandErrors = new Map<string, string>();

  reset(): void {
    this.inputRejection = null;
    this.commandErrors.clear();
  }

  rejectInput(rejection: any): void { this.inputRejection = rejection; }

  markNotice(event: any): void {
    if (event.method === 'notify' && event.notifyType === 'error' && jsonEqual(event.message, this.inputRejection?.error)) event.inputRejected = true;
  }

  commandFailed(event: any): void {
    const path = typeof event.extensionPath === 'string' ? event.extensionPath : '';
    const command = path.startsWith('command:') ? path.slice(8) : '';
    this.commandErrors.set(command, typeof event.error === 'string' ? event.error : 'Extension command failed');
  }

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
