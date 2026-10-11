# Host scripts are copied to each host by hash

The daemon copies each Host script once into the profile storage folder of the host, in a file named by the hash of the script, and sends the request as JSON on stdin. Before, the script and its request went on the command line. On a remote host the whole command is one argument to `bash -lc`, and Linux limits one argument to 128 KiB. The storage inventory script was already 87 KB, and a storage transaction with many session paths could go past the limit.

## Considered Options

- Send only the request on stdin and keep the script on the command line. Rejected: the scripts grow, so the limit stays.
- Send the script itself on stdin. Rejected: the storage transaction lock starts the same script again to hold the lock, and stdin cannot be read a second time.
