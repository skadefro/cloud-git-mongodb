# Cloud-git: Node.js git server for cloud-native applications

[Cloud-git](https://fusebit.io/blog/make-git-your-api/) is a 100% JavaScript git server you can expose as part of the HTTP APIs of your app:

* Expose a Git repository as an Express route of your application.
* Pure JavaScript, no dependencies on native git libraries.
* Extensible to use any cloud-native storage like AWS S3, no dependency on the file system.
* HTTP or HTTPS.
* Read/write (push/pull).
* Supports authentication.
* Can be used with regular git CLI.

## Demo
For the demo, you can either create a `.env` file with your configuration settings or supply the MongoDB URL directly as an environment variable when starting the server. Additionally, there is an option to use a memory provider instead of MongoDB for testing purposes.
```
npm i
MONGO_URL=mongodb://localhost:27017 node sample/server.js
# or to use memory provider
node sample/server.js
```

## MongoDB Repository
When using MongoGitRepository, it is necessary to provide:
- A MongoDB database instance.
- A collection name to store REFs in, which includes branch and tag references.
- A "path" which acts as the repository name.

This setup will create a GridFS bucket to store all files in. If your path is `test/myrepp`, you will get a `test_myrepp.files` and `test_myrepp.chunks` collection that MongoDB uses to store files. Pushing to a repo will by default create repositories named main or master as the HEAD repo. You can set `repo.uploadasync` to false to speed up uploads at the risk of potential inconsistency in the repository, though this is not recommended.

In addition to the original functionality of [cloud-git](https://github.com/fusebit/cloud-git), this version has added:
- **report-status**: Adds report-status capability.
- **parseCommit**: Parses a commit object and returns commit information.
- **parseTag**: Parses a tag object and returns tag information.
- **parseTree**: Traverses a tree object and returns the directory listing inside it. If recursive is true, it also traverses all subfolders found and adds them as a subtree to each directory.
- **GetTree**: Given the SHA of a commit or tree, it retrieves the directory listing for that.

The main differences from the original repository include support for git commands sending data gzip compressed, parsing packs after the client has sent all data to drastically improve speed and lower memory usage, fixing the retrieval of former objects when handling deltified files, minor syntax updates for easier integration into TypeScript projects, and more.

## Usage
For full usage description and more information, see the original [cloud-git](https://github.com/fusebit/cloud-git) repository.

