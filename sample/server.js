require("dotenv").config()

const Express = require("express");

async function CreateTestTag(repo) {
  await repo.createAnnotatedTag("test", "testtag", "az <az@example.com>", "Test tag");

  await CreateAndUpdateTestBranch(repo);

  await repo.createLightweightTag("test", "testtag-light");

}
async function CreateAndUpdateTestBranch(repo) {
  const { parseTree, parseCommit, createTree, createCommit, objectSha } = await import("../lib/tools.mjs");

  const ref = "refs/heads/test";
  let parent = null;

  // Retrieve the parent commit SHA
  const branches = await repo.getRefs();
  if(branches.find(x => x.ref == ref)) {
    parent = branches.find(x => x.ref == ref).sha;
  } else {
    const branch = branches.find(x => x.ref == "refs/heads/master" || x.ref == "refs/heads/main");
    if (branch != null) {
      parent = branch.sha;
    }
  }

  if (parent == null) {
    throw new Error("Parent branch not found");
  }

  // Retrieve the parent tree entries
  const parentObject = await repo.getObject(null, parent);
  const parentCommit = parseCommit(parentObject);
  const parentTree = await repo.getObject(null, parentCommit.tree);
  let parentEntries = await parseTree(repo, parentTree);

  // Create a new blob for README.md
  const filename = "README.md";
  const content = `# Test\n\nThis is a test file\n\n` + Math.random();
  let object = {
    "objectType": 3, // blob
    "data": Buffer.from(content),
    "contentType": "text/plain",
  };
  object.sha = objectSha(object);
  await repo.storeObject(object);

  // Update the tree entries with the new README.md blob
  let treeEntries = parentEntries.map(entry => {
    if (entry.name.toLowerCase() === filename.toLowerCase()) {
      return { mode: 33188, name: entry.name, sha: object.sha };
    }
    return entry;
  });

  // If the README.md file is not found, add it to the entries
  if (!treeEntries.find(entry => entry.name.toLowerCase() === filename.toLowerCase())) {
    treeEntries.push({ mode: 33188, name: filename, sha: object.sha });
  }

  // Create and store the new tree object
  const tree = createTree(treeEntries);
  await repo.storeObject(tree);

  // Create and store the new commit object
  const author = "az <az@example.com> " + Math.floor(Date.now() / 1000) + " +0000";
  const committer = "az <az@example.com> " + Math.floor(Date.now() / 1000) + " +0000";
  const message = "test commit";

  const commit = createCommit({ tree: tree.sha, parent, author, committer, message });
  await repo.storeObject(commit);

  // Update the branch reference
  await repo.collection.updateOne(
    { repo: repo.repoName, ref },
    { $set: { repo: repo.repoName, ref, name: ref + " " + commit.sha, sha: commit.sha, _type: "hash" } },
    { upsert: true }
  );

}

const { MongoClient } = require("mongodb");
const memoryrepo = process.env.MONGO_URL == null || process.env.MONGO_URL == "";
async function main() {
  try {
    const { MongoGitRepository, Protocol } = await import("../lib/index.mjs");
    const { setDebugHandler, parseTree } = await import("../lib/tools.mjs");
    // setDebugHandler((...args) => {
    //   console.log.apply(this, args);
    // });
    const mongodburl = process.env.MONGO_URL || "mongodb://localhost:27017";
    const mongodb = process.env.MONGO_DB || "git";
    const mongocol = process.env.MONGO_COL || "repos";
    /**
     * @type {MongoClient}
    **/
    let cli = null;
    if (memoryrepo == false) {
      cli = await MongoClient.connect(mongodburl);
    }
    const app = Express();
    const repos = {}
    app.use("/git*", async (req, res, next) => {
      try {
        var url = req.originalUrl;
        if (url.indexOf("?") > 0) {
          url = url.substring(0, url.indexOf("?"));
        }
        let parts = url.split("/");
        let path = parts[2];
        // let repo = repos[path];
        /** @type {import("../lib/index.mjs").MongoGitRepository} */
        let repo;
        if (repo == null && path != null && path != "") {
          if (memoryrepo == true) {
            throw new Error("Memory repository not supported anymore")
          } else {
            repo = new MongoGitRepository(cli.db(mongodb), mongocol, path);
          }
          repo.createExpress(app, "/git/" + path);
          repos[path] = repo;
        }
        if (repo != null && repo.ignoreRequest(req)) {
          return next();
        } else if (parts.length == 2 || (parts.length == 3 && path == "")) {
          var html = `<html><body><a href="/git">repos</a><ul>`;
          var _repos = [];
          if (memoryrepo == false) {
            _repos = await cli.db(mongodb).collection(mongocol).distinct("repo");
            for (var i = 0; i < _repos.length; i++) {
              html += `<li><a href="/git/${_repos[i]}">${_repos[i]}</a>`;
              html += ` <a href="/git/${_repos[i]}/delete">del</a>`;
              if (_repos[i] == "test1") {
                html += ` <a href="/git/${_repos[i]}/test">test</a>`;
                html += ` <a href="/git/${_repos[i]}/testtag">testtag</a>`;
              }
              html += `</li>`;
              // 
            }
          } else {
            var keys = Object.keys(repos);
            for (var i = 0; i < keys.length; i++) {
              const key = keys[i];
              if (_repos.indexOf(key) < 0) {
                html += `<li><a href="/git/${key}">${key}</a>`;
              }
            }
          }
          html += "</ul></body></html>";
          res.status(200).send(html);
          next();
        } else if (parts.length == 3) {
          var branches = await repo.GetBranches();
          branches.sort((a, b) => a.ref.localeCompare(b.ref));
          var html = `<html><body><a href="/git">repos</a> | <a href="/git/"+path+"">branches</a><ul>`;
          for (let i = 0; i < branches.length; i++) {
            var ref = branches[i].ref;
            if (ref == "HEAD") continue;
            html += `<li><a href="/git/${path}/${encodeURIComponent(ref)}">branch ${ref}</a></li>`;
          }
          html += "</ul></body></html>";
          res.status(200).send(html);
          next();
        } else if ((parts.length == 4 && parts[3] != "delete" && parts[3] != "test" && parts[3] != "testtag") || parts.length == 5) {
          var ref = parts[3];
          if (parts.length == 4) {
            var html = `<html><body><a href="/git">repos</a> | <a href="/git/"+path+"">branches</a><ul>`;
            var branches = await repo.GetBranches();
            var branch = branches.find(x => x.ref == decodeURIComponent(parts[3]));
            if (branch == null) {
              return res.status(404).send("File not found");
            }
            var files = await repo.GetTree(branch.sha, false);
          } else {
            var html = `<html><body><a href="/git">repos</a> | <a href="/git/"+path+"">branches</a> | <a href="javascript:history.back()"">Go Back</a><ul>`;
            var sha = parts[4];
            const file = await repo.getObject(null, sha);
            if (!file) {
              return res.status(404).send("File not found");
            }
            if (file.objectType == "tree" || file.objecttype == "tree" || file.objectType == 2) {
              var files = await parseTree(repo, file, false);
            } else {
              if (req.query.download != null) {
                res.set({
                  "Content-Type": file.contentType,
                  "Content-Disposition": `attachment; filename="${sha}"`,
                });
                res.write(file.data);
                return res.end();
              }
              var html = `<html><body><a href="/git">repos</a> | <a href="/git/"+path+"">branches</a> | <a href="javascript:history.back()"">Go Back</a>`;
              html += `<p><pre>${file.data.toString("utf8")}</p></pre>`
              html += `</ul></body></html>`;
              res.status(200).send(html);
              next();
              return;
            }
          }
          files.sort((a, b) => a.name.localeCompare(b.name));
          for (let i = 0; i < files.length; i++) {
            const file = files[i]
            if (file.mode != 40000 && file.mode != 16384) continue;
            html += `<li><a href="/git/${path}/${ref}/${file.sha}">${file.name}</a></li>`;
          }
          let readme = "";
          for (let i = 0; i < files.length; i++) {
            const file = files[i]
            if (file.mode == 40000) continue;
            if (file.name.toLowerCase() == "readme.md") readme = (await repo.getObject(undefined, file.sha)).data.toString("utf8");
            html += `<li><a href="/git/${path}/${ref}/${file.sha}">${file.name}</a> | <a href="/git/${path}/${ref}/${file.sha}?download=${Math.random().toString(36).substring(7)}">download</a></li>`;
          }
          html += `</ul><p><pre>${readme}</pre></p></body></html>`;
          res.status(200).send(html);
          next();
        } else if (parts.length == 4 && parts[3] == "test") {
          await CreateAndUpdateTestBranch(repo);
          res.status(200).send(`Tested<p><a href="/git">back</p>`);
          next();
        } else if (parts.length == 4 && parts[3] == "testtag") {
          await CreateTestTag(repo);
          res.status(200).send(`Tested<p><a href="/git">back</p>`);
          next();
        } else if (parts.length == 4 && parts[3] == "delete") {
          repo.removeExpress(app, path);
          await repo.DeleteRepo();
          res.status(200).send(`Deleted<p><a href="/git">back</p>`);
          delete repos[path];
          next();
        } else {
          res.status(404).send("Not Found");
          next();
        }
      } catch (error) {
        console.error("error", url, error.message);
        res.status(500).send(`Internal Server Error: ${error.message}`);
        next();
      }
    });

    const server = require("http")
      .createServer(app)
      .listen(3000, () => {
        console.log("Your git repositories are available at http://localhost:3000/git/");
      });

    // timeout work around.
    // parsing packages is brain-dead slow ... it takes FOREVER if a client is pushing a big file.
    // update: ok, found a work around by only parsing pack once client has sent it all.
    // but leaving this here just in case.
    server.timeout = 240000 * 10; // Set timeout to 40 minutes
    server.keepAliveTimeout = 240000 * 10; // Increase keep-alive timeout to match server timeout
    server.headersTimeout = server.keepAliveTimeout + 1000; // Slightly longer than keepAliveTimeout    
  } catch (error) {
    console.error("error", error.message);
  }
}
main();
