/*
 * See also:
 *
 *   * https://forums.meteor.com/t/meteor-1-3-and-babel-options/15275
 *   * https://github.com/meteor/meteor/issues/6351
 */

/*
 * Needed in core:
 *
 *   * Add .babelrc to watchlist, handle more gracefully.
 *   * meteor-babel needs ability for custom cache hash deps (will submit PR)
 *
 * TODO here
 *
 *   * {babelrc:false} also disables .babelignore, but that should be fine
 *     since we hand pick the files to compile anyway.
 *
 */

/*
 * True if we're in a server package (vs build-plugin inside of meteor-tool)
 */
if (process.env.APP_ID) {
  if (Meteor.isTest)
    return;

  // Our new way to ensure that the meteor preset is at required version
  // Only necessary to warn in development; these packages are only used in
  // the build process, and aren't packed for deployment.
  if (process.env.NODE_ENV === 'development') {
    var checkNpmVersions = Package['tmeasday:check-npm-versions'].checkNpmVersions;
    checkNpmVersions({
      'babel-preset-meteor': '^6.6.7'
    }, 'gadicc:ecmascript-hot');
  }

  // Ideally we should still read in babelrc's and only warn if they use the
  // preset.

  // Nothing else in this file needs to be run on the server (vs build plugin)
  return;
}

/*
 * Code below here is run in the build plugin only
 */

var fs = Npm.require('fs');
var path = Npm.require('path');
var crypto = Npm.require('crypto');
var mkdirp = Npm.require('mkdirp');
// var JSON5 = Npm.require('json5');  now from 'json5' package on atmosphere

// XXX better way to do this?
var tmp = null;
projRoot = process.cwd();

while (projRoot !== tmp && !fs.existsSync(path.join(projRoot, '.meteor'))) {
  tmp = projRoot;  // used to detect drive root on windows too
  projRoot = path.normalize(path.join(projRoot, '..'));
}

if (projRoot === tmp) {
  // We stop processing this file here in a non-devel environment
  // because a production build won't have a .meteor directory.
  // We need it during the build process (which is also "production"),
  // but for now we assume that this kind of error would be detected
  // during development.  Would love to hear of alternative ways to do
  // this.  Could maybe check for "local/star.json" to identify devel build.
  if (process.env.NODE_ENV !== 'development')
    return;
  else
    throw new Error("Are you running inside a Meteor project dir?");
}

// now used in hothacks to send to accel
//var
babelrc = { root: {}, client: {}, server: {} };
for (var key in babelrc) {
  var obj = babelrc[key];
  obj.path = path.join(projRoot, key=='root'?'':key, '.babelrc');
  obj.exists = fs.existsSync(obj.path);

  if (key === 'root' && !obj.exists) {
    console.log('Creating ' + obj.path);
    obj.raw = Assets.getText('babelrc-skel');
    var dir = path.dirname(obj.path);
    mkdirp.sync(dir);
    fs.writeFileSync(obj.path, obj.raw);
    obj.exists = true;
  }

  // meteor-react-hotloader specific
  if (key === 'client' && !obj.exists) {
    console.log('Creating ' + obj.path);
    obj.raw = Assets.getText('babelrc-client-skel');
    var dir = path.dirname(obj.path);
    mkdirp.sync(dir);
    fs.writeFileSync(obj.path, obj.raw);
    obj.exists = true;
  }

  if (obj.exists) {

    if (!obj.raw)
      obj.raw = fs.readFileSync(obj.path, 'utf8');

    obj.hash = crypto.createHash('sha1').update(obj.raw).digest('hex');

    try {
      obj.contents = JSON5.parse(obj.raw);
    } catch (err) {
      console.log("Error parsing your " + key + "/.babelrc: " + err.message);
      process.exit(); // could throw err if .babelrc was in meteor's file watcher
    }

    // Maybe we should allow anything and hash appropriately?  But then we'd
    // also have to recursively follow any possible 'extends' chain.
    if (obj.contents.extends) {
      if (key === 'root') {
        console.log("Warning, we don't support 'extends' in your root .babelrc. "
          + "For now, you should modify your .babelrc too every time you change '"
          + obj.contents.extends + "' to clear the cache");
      } else {
        if (obj.contents.extends !== '../.babelrc')
          console.log("Warning, we only support extending '../.babelrc' in "
            + "your client/server .babelrc.  For now, you should modify this "
            + "file too anytime your 'extends' file changes, to clear the "
            + "cache");

        // Since we extend ../.babelrc, we need to include that too.
        obj.combinedHash = crypto.createHash('sha1')
          .update(obj.hash + babelrc.root.hash).digest('hex');
      }
    }

    /*
     * Quit on .babelrc change (need to rebuild all files through babel).
     */
    fs.watch(obj.path, function(event) {
      console.log("Your " + key + "/.babelrc was changed, please restart Meteor.");
      process.exit();
    });

  }
}

// meteor-react-hotloader specific
if (babelrc.root.raw.match(/react-transform/)) {
  console.log("Since ecmascript-hot@1.3.0-2:");
  console.log("We suggest removing all the hotloading transforms from your root "
    + ".babelrc and placing them in client/.babelrc instead.  Since such a file "
    + "was most likely already created for you, all that remains for you to do "
    + "is to remove this old section from your root .babelrc");
}

/*
 * XXX TODO Don't force { "presets": [ "meteor" ] }
 * If they have a `presets` field set, they probably know what they're doing.
 * If they don't, we can warn with the appropriate suggestion.
 * Before enabling this, need to see what else the meteor preset includes;
 * perhaps require a certain plugin if the preset isn't used, etc.
 */
if (!babelrc.root.contents.presets /* || babelrc.presets.indexOf('meteor') === -1 */) {
  console.log('Your .babelrc must include at least { "presets": [ "meteor" ] }');
  process.exit(); // could throw err if .babelrc was in meteor's file watcher
}

// package global; used in hothacks.js to cover relevent package.json aswell.
babelOtherDeps = {};

function archType(arch) {
  if (arch.substr(0, 4) === 'web.')
    return 'client';
  if (arch.substr(0, 3) === 'os.');
    return 'server';
  throw new Error("Unkown architecture: " + arch);
}

/*
 * Wow, in the end, this is all we need and babel does the rest in
 * the right way.
 */
mergeBabelrcOptions = function(options, inputFile) {
  var arch = archType(inputFile.getArch());

  var obj = babelrc[arch];
  if (!obj.exists)
    obj = babelrc.root;

  options.extends = obj.path;

  return {
    babelrcHash: obj.combinedHash || obj.hash,

    // Because .babelrc may contain env-specific configs
    // Default is 'development' as per http://babeljs.io/docs/usage/options/
    BABEL_ENV: process.env.BABEL_ENV || process.env.NODE_ENV || 'development',

    // From other files, e.g. hothacks pkgSettings
    otherDeps: babelOtherDeps
  };
}
