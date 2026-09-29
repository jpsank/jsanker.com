import React, { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { doc, onSnapshot, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "../services/firebase";
import '@mdxeditor/editor/style.css';
import {
    MDXEditor,
    AdmonitionDirectiveDescriptor,
    UndoRedo,
    // codeBlockPlugin,
    // codeMirrorPlugin,
    diffSourcePlugin,
    directivesPlugin,
    frontmatterPlugin,
    headingsPlugin,
    imagePlugin,
    linkDialogPlugin,
    linkPlugin,
    listsPlugin,
    markdownShortcutPlugin,
    quotePlugin,
    // sandpackPlugin,
    tablePlugin,
    thematicBreakPlugin,
    toolbarPlugin,
    Separator,
    BlockTypeSelect,
    BoldItalicUnderlineToggles,
    CreateLink,
    DiffSourceToggleWrapper,
    InsertImage,
    ListsToggle,
} from '@mdxeditor/editor';
import { Container } from "react-bootstrap";
import Skeleton from "react-loading-skeleton";
import { useAuth } from "../contexts/AuthContext";


const BlogEdit = () => {
    const params = useParams();
    const [blog, setBlog] = useState(null);
    const { currentUser } = useAuth();

    useEffect(() => {
        const unsubscribe = onSnapshot(doc(db, "blogs", params.id), (doc) => {
            setBlog(doc.data());
        });
        return () => unsubscribe();
    }, [params.id]);

    useEffect(() => {
        if (blog !== null && currentUser && currentUser.uid !== blog.authorId) {
            window.location.href = "/blogs/" + params.id;
        }
    }, [blog, currentUser, params.id]);

    const handleUpdate = async (content) => {
        await updateDoc(doc(db, "blogs", params.id), {
            dateUpdated: serverTimestamp(),
            content: content,
        });
    };

    return (
        <Container className="my-5 mx-sm-5 mx-0">
            { blog === null ? <Skeleton count={15} containerClassName="mt-5" /> : (
                <MDXEditor
                    markdown={blog.content}
                    onChange={handleUpdate}
                    plugins={[toolbarPlugin({
                        toolbarContents: () => (
                                <>
                                    <DiffSourceToggleWrapper>
                                        <UndoRedo />
                                        <BoldItalicUnderlineToggles />
                                        <ListsToggle />
                                        <Separator />
                                        <BlockTypeSelect />
                                        <CreateLink />
                                        <InsertImage />
                                        <Separator />
                                    </DiffSourceToggleWrapper>
                                </>
                            )
                        }),
                        listsPlugin(),
                        quotePlugin(),
                        headingsPlugin(),
                        linkPlugin(),
                        linkDialogPlugin(),
                        imagePlugin(),
                        tablePlugin(),
                        thematicBreakPlugin(),
                        frontmatterPlugin(),
                        // codeBlockPlugin({ defaultCodeBlockLanguage: 'txt' }),
                        // sandpackPlugin({ sandpackConfig: virtuosoSampleSandpackConfig }),
                        // codeMirrorPlugin({ codeBlockLanguages: { js: 'JavaScript', css: 'CSS', txt: 'text' } }),
                        directivesPlugin({ directiveDescriptors: [AdmonitionDirectiveDescriptor] }),
                        diffSourcePlugin({ viewMode: 'rich-text', diffMarkdown: blog.content }),
                        markdownShortcutPlugin()
                    ]}
                />
            )}
        </Container>
    );
}

export default BlogEdit;
