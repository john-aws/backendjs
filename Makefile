#
#  Author: Vlad Seryakov vseryakov@gmail.com
#  Sep 2013
#

pages:
	git-new-workdir backendjs bkjs-pages gh-pages

update:
	cd ../backendjs && npm run doc
	cp ../backendjs/bkjs ../backendjs/web/doc.html .
	git commit -a -m docs && git push
	cp bkjs site/
	cd site && git commit -a -m updates && git push

