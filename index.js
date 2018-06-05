const spawn = require('child-process-promise').spawn;
const os = require('os');
const path = require('path');
const sizeOf = require('image-size');

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const database = admin.firestore();

const firebaseKey = require('./firebase-sdk-stage.json');
//const firebaseKey = require('./firebase-sdk-production.json');
// ^---- And adjust .firebaserc
const gcs = require('@google-cloud/storage')({
  credential: admin.credential.cert(firebaseKey)
});

exports.processUploads = functions.storage.object().onFinalize((object, context) => {

  // Basic constants
  const JPEG_EXTENSION = '.jpg';
  const COMPRESSED_PREFIX = 'full_';
  const THUMB_MAX_HEIGHT = 500;
  const THUMB_MAX_WIDTH = 500;
  const THUMB_PREFIX = 'thumb_';
  const CONFIG = {
    action: 'read',
    expires: '03-01-2500',
  };

  // Other data to pull out
  const contentType = object.contentType; // File content type.
  const resourceState = object.resourceState; // The resourceState is 'exists' or 'not_exists' (for file/folder deletions).
  const metageneration = object.metageneration; // Number of times metadata has been generated. New objects have a value of 1.

  const bucketName = object.bucket;
  const bucket = gcs.bucket(bucketName);

  const originalPath = object.name; // Full path --> folder/subfolder/picture.png
  const originalDirectory = path.dirname(originalPath); // Directory --> folder/subfolder
  const originalFile = path.basename(originalPath);  // File --> picture.png
  const originalFileBare = path.basename(originalPath, path.extname(originalPath)); // File no ext --> picture

  const pathPieces = originalDirectory.split('/'); // [ '9AnnEvelbPM6Y8dkhK6V', 'reports', 'L7yrlcpDQRePkFMDMDTD', 'mi4FaNOkZIzKiyfJWjvH', '2sVbq' ]
  const reportId = pathPieces[2];
  const fieldId = pathPieces[3];
  const fileId = pathPieces[4];

  if (resourceState === 'not_exists') {
    //console.log('This is a deletion event.');
    return null;
  }

  if (resourceState === 'exists' && metageneration > 1) {
    //console.log('This is a metadata change event.');
    return null;
  }

  if (originalFile === 'logo.png') {
    //console.log('This is probably a logo from an organization upload.');
    return null;
  }

  if (contentType.startsWith('image/')) {
    // This is an image
    const newFile = COMPRESSED_PREFIX + originalFileBare + JPEG_EXTENSION;
    const newFileThumb = THUMB_PREFIX + originalFileBare + JPEG_EXTENSION;
    const newPath = path.join(originalDirectory, newFile);
    const newPathThumb = path.join(originalDirectory, newFileThumb);
    const tempLocalPath = path.join(os.tmpdir(), originalFile);
    const tempLocalPathThumb = path.join(os.tmpdir(), newFileThumb);

    // Exit early under these circumstances
    if (!contentType.startsWith('image/')) {
      //console.log('This is not an image.');
      return null;
    }

    if (originalFile.startsWith(COMPRESSED_PREFIX)) {
      //console.log('Already compressed.');
      return null;
    }

    if (originalFile.startsWith(THUMB_PREFIX)) {
      //console.log('Already a Thumbnail.');
      return null;
    }

    // Storage spots
    const metadata = { contentType: contentType };
    const fullPhoto = bucket.file(newPath);
    const thumbPhoto = bucket.file(newPathThumb);

    let fullPhotoUrl;
    let thumbPhotoUrl;
    let photoWidth;
    let photoHeight;

    // Download image
    return bucket.file(originalPath).download({
      destination: tempLocalPath
    }).then(() => {
      if (!contentType.startsWith('image/jpeg')) {
        //console.log('Converting to jpg');
        return spawn('mogrify', ['-format', 'jpg', tempLocalPath]);
      } else {
        console.log('Already a jpeg');
        return;
      }
    }).then(() => {
      //console.log('Compressing and shrinking image');
      return spawn('mogrify', ['-auto-orient', '-resize', '1800x1800', '-quality', '75', tempLocalPath]);
    }).then(() => {
      //console.log('Uploading compressed image');
      const dimensions = sizeOf(tempLocalPath);
      photoWidth = dimensions.width;
      photoHeight = dimensions.height;
      return bucket.upload(tempLocalPath, {
        destination: newPath,
        metadata: metadata
      });
    }).then(() => {
      //console.log('Creating thumbnail');
      return spawn('convert', ['-define', 'jpeg:size=500x500', tempLocalPath, '-auto-orient', '-thumbnail', `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}^`, '-quality', '90', '-gravity', 'center', '-extent', `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}^`, tempLocalPathThumb]);
    }).then(() => {
      return bucket.upload(tempLocalPathThumb, {
        destination: newPathThumb,
        metadata: metadata
      });
    }).then(() => {
      return Promise.all([
        fullPhoto.getSignedUrl(CONFIG),
        thumbPhoto.getSignedUrl(CONFIG)
      ]);
    }).then((results) => {
      const fullPhotoResult = results[0];
      const thumbPhotoResult = results[1];
      fullPhotoUrl = fullPhotoResult[0];
      thumbPhotoUrl = thumbPhotoResult[0];
      return database.collection('reports').where('id', '==', reportId).get();
    }).then((savedReport) => {
      const updates = [];
      savedReport.forEach((currentReport) => {
        updates.push(currentReport.ref.collection('files').add({
          storageReference: newPath,
          storageReferenceThumb: newPathThumb,
          fileId,
          fieldId,
          fullPhotoUrl,
          thumbPhotoUrl,
          photoHeight,
          photoWidth
        }));
      });
      return Promise.all(updates);
    }).then(() => {
      console.log('Uploaded =>', originalFile);
      return bucket.file(originalPath).delete();
    }).catch((e) => {
      console.log(e);
      return null;
    });
  } else {
    // This is not an image
    const nonimageFile = bucket.file(originalPath);
    let fileUrl;
    return nonimageFile.getSignedUrl(CONFIG).then((results) => {
      fileUrl = results[0];
      return database.collection('reports').where('id', '==', reportId).get()
    }).then((savedReport) => {
      savedReport.forEach((currentReport) => {
        const updates = [];
        savedReport.forEach((currentReport) => {
          updates.push(currentReport.ref.collection('files').add({
            storageReference: originalPath,
            fileId,
            fieldId,
            fileUrl
          }));
        });
        return Promise.all(updates);
      });
    }).catch((e) => {
      //console.log(e);
      return null;
    });
  }
});





