const readyMessage = document.createElement('p');
readyMessage.setAttribute('role', 'status');
readyMessage.textContent = 'Ready';
document.getElementById('root')!.append(readyMessage);
