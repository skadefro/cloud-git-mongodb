# Cloud-git: Node.js git server for cloud-native applications

[Cloud-git](https://fusebit.io/blog/make-git-your-api/) is a 100% JavaScript git server you can expose as part of the HTTP APIs of your app: 

* Expose a Git repository as an Express route of your application. 
* Pure JavaScript, no dependencies on native git libraries. 
* Extensible to use any cloud-native storage like AWS S3, no dependency on the file system. 
* HTTP or HTTPS.
* Read/write (push/pull). 
* Supports authentication.
* Can be used with regular git CLI.

## demo
Either create a .env file, or supply mongodb url direcly.
```
npm i
MONGO_URL=mongodb://localhost:27017 node sample/server.js
```
Or update server.js to use MemoryGitRepository instead of MongoGitRepository.

## MongoDB Repository
When using MongoGitRepository you need to give the contructor a 
- MongoDB db instance
- a collection name to store REF's in (branch and tag references)
- a "path" ( repository name )

This will create a GridFS bucket to store all files in. If you path is `test/myrepp` you will get a `test_myrepp.files` and `test_myrepp.chunks` collection that mongodb store files in.
When pushing to a repo, it will by default make repo's with name main or master, the HEAD repo ( default repository ).
You can set repo.uploadasync to false to skip waiting on each upload, but then risk something could have gone wrong and you have an inconsistent repository. This will bost speed even more, but **not** recommended.

Besides the original functionality of [cloud-git](https://github.com/fusebit/cloud-git) I have also added 
 - **parseCommit**: Will parse a commit object and return commit information.
 - **parseTree**: Will traverse a tree object and return the directory listing inside side it. If recursive is true, it will also traverse all sub folders found and add them as subtree on the each directory.
 - **GetTree**: Given the sha of a commit or tree it will get the directory listning for that.

The main difference from the original repo is
 - Support for git command sending data gzip compressed ( why would it ? makes no sense when pack data is already compressed :-/ )
 - Parse packs after client have send all data. This will **drasticly** improve speed and lower memory usage, since concatting buffer is slow in nodejs and calling `zlib.inflateSync` for every package received is rather cpu intensive for larger files.
 - Fix getting former object when handling deltified files ( this is why the repo is not added as parameter to protocol )
 - Minor syntax updates for easy copy'b'paste into typescript projects.

## Usage
For full usage description and more information see original [cloud-git](https://github.com/fusebit/cloud-git) repository
