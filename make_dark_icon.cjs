const sharp = require('sharp');

async function processImage() {
  const { data, info } = await sharp('public/transparentIcon.png')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Target dark color to replace the light color
  const darkR = 16;
  const darkG = 35;
  const darkB = 52;
  
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    if (a > 0) {
      // The light color is around 248, 243, 234
      // The teal color is around 82, 196, 185
      // If it's mostly light (e.g., r > 150), we darken it
      if (r > 150 && g > 150) {
        // Calculate how "white" it is to preserve anti-aliasing if needed, 
        // but since it's already anti-aliased via alpha, we can just swap the RGB
        data[i] = darkR;
        data[i + 1] = darkG;
        data[i + 2] = darkB;
      }
    }
  }

  await sharp(data, { raw: info })
    .png()
    .toFile('public/transparentIcon-dark.png');
    
  console.log('Dark icon generated');
}

processImage();
