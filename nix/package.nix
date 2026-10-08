{ buildNpmPackage, importNpmLock, nodejs_22, makeWrapper }:

buildNpmPackage {
  pname = "opendub";
  version = "0.2.0";
  src = ../.;
  npmDeps = importNpmLock { npmRoot = ../.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  dontNpmBuild = true;
  nativeBuildInputs = [ makeWrapper ];
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/opendub" "$out/bin"
    cp -r server web bin package.json node_modules "$out/lib/opendub/"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/opendub" \
      --add-flags "$out/lib/opendub/server/index.js"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/opendub-auth" \
      --add-flags "$out/lib/opendub/bin/opendub-auth"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/opendub-steam" \
      --add-flags "$out/lib/opendub/bin/opendub-steam"
    runHook postInstall
  '';
}
